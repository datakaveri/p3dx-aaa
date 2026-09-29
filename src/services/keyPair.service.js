import { createHash, createPublicKey } from 'crypto';
import { logAuditEvent } from './immudb.service.js';
import { getAdminToken, getUserById, setUserAttribute } from './keycloak.service.js';

// The realm's Keycloak User Profile only persists attributes it has declared
// (undeclared ones are silently stripped on save) — "public_key" is the one
// declared there.
const PUBLIC_KEY_ATTRIBUTE = 'public_key';

const MIN_MODULUS_BITS = 2048;

export const KEY_PAIR_ROLES = new Set(['data-provider', 'infra-provider']);

// One key pair per USER, generated in the provider's browser (see
// p3dx-auth-ui api/keyPair.js). The platform never sees or stores the
// private key — only the public half is uploaded, and it lives solely in the
// user's Keycloak "public_key" attribute, where gov_layer's userdir reads it
// to verify contract-hash signatures. Nothing key-related goes to immuDB.

export class InvalidPublicKeyError extends Error {}

/**
 * Validate a PEM public key uploaded by the provider and publish it to their
 * Keycloak profile, replacing any previous one. Must be an RSA SPKI
 * ("-----BEGIN PUBLIC KEY-----") key of at least 2048 bits — the format
 * gov_layer parses with x509.ParsePKIXPublicKey and verifies with
 * RSASSA-PKCS1-v1_5 / SHA-256.
 */
export async function registerPublicKey({ userId, roleName, publicKeyPem }) {
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.trim()) {
    throw new InvalidPublicKeyError('MISSING_PUBLIC_KEY');
  }
  // Refuse outright if a private key was pasted/uploaded by mistake, so it
  // can't end up in logs or Keycloak.
  if (/PRIVATE KEY/.test(publicKeyPem)) {
    throw new InvalidPublicKeyError('PRIVATE_KEY_NOT_ACCEPTED');
  }
  if (!/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----\s*$/.test(publicKeyPem.trim())) {
    throw new InvalidPublicKeyError('EXPECTED_SPKI_PEM');
  }

  let keyObject;
  try {
    keyObject = createPublicKey({ key: publicKeyPem, format: 'pem' });
  } catch {
    throw new InvalidPublicKeyError('INVALID_PUBLIC_KEY');
  }
  if (keyObject.asymmetricKeyType !== 'rsa') {
    throw new InvalidPublicKeyError('EXPECTED_RSA_KEY');
  }
  if ((keyObject.asymmetricKeyDetails?.modulusLength || 0) < MIN_MODULUS_BITS) {
    throw new InvalidPublicKeyError('KEY_TOO_SHORT');
  }

  // Re-export so what's stored is a normalised SPKI PEM.
  const normalisedPem = keyObject.export({ type: 'spki', format: 'pem' });
  const fingerprint = createHash('sha256')
    .update(keyObject.export({ type: 'spki', format: 'der' }))
    .digest('hex');

  const adminToken = await getAdminToken();
  const hadKey = Boolean(await readPublicKey(userId, adminToken));
  await setUserAttribute(userId, PUBLIC_KEY_ATTRIBUTE, normalisedPem, adminToken);

  await logAuditEvent(hadKey ? 'PROVIDER_PUBLIC_KEY_ROTATED' : 'PROVIDER_PUBLIC_KEY_REGISTERED', userId, {
    roleName,
    fingerprint_sha256: fingerprint,
    timestamp: new Date().toISOString(),
  });

  return { fingerprint };
}

/**
 * Whether the user has a public key registered in Keycloak.
 */
export async function getPublicKeyStatus({ userId }) {
  const adminToken = await getAdminToken();
  return { exists: Boolean(await readPublicKey(userId, adminToken)) };
}

async function readPublicKey(userId, adminToken) {
  const user = await getUserById(userId, adminToken);
  const value = user?.attributes?.[PUBLIC_KEY_ATTRIBUTE];
  return Array.isArray(value) ? value[0] || null : value || null;
}
