import { createHash, createPublicKey } from 'crypto';
import { logAuditEvent } from './immudb.service.js';

// gov_layer stores the keys in its Postgres (provider_public_keys) and reads
// them from there to verify contract-hash signatures.
const GOV_LAYER_URL = (process.env.GOV_LAYER_URL || 'http://localhost:8083').replace(/\/+$/, '');

const MIN_MODULUS_BITS = 2048;

export const KEY_PAIR_ROLES = new Set(['data-provider', 'infra-provider']);

// One key pair per USER, generated in the provider's browser (see
// p3dx-auth-ui api/keyPair.js). The platform never sees or stores the
// private key — only the public half is uploaded, and it lives solely in
// gov_layer's Postgres. The provider's own access token is forwarded to
// gov_layer, which takes the username the key is stored under from it.
// Nothing key-related goes to immuDB beyond the audit event.

export class InvalidPublicKeyError extends Error {}

/**
 * Validate a PEM public key uploaded by the provider and store it in
 * gov_layer, replacing any previous one. Must be an RSA SPKI
 * ("-----BEGIN PUBLIC KEY-----") key of at least 2048 bits — the format
 * gov_layer parses with x509.ParsePKIXPublicKey and verifies with
 * RSASSA-PKCS1-v1_5 / SHA-256.
 */
export async function registerPublicKey({ userId, roleName, publicKeyPem, accessToken }) {
  if (typeof publicKeyPem !== 'string' || !publicKeyPem.trim()) {
    throw new InvalidPublicKeyError('MISSING_PUBLIC_KEY');
  }
  // Refuse outright if a private key was pasted/uploaded by mistake, so it
  // can't end up in logs or gov_layer.
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

  const data = await callGovLayer('PUT', `/provider-keys/${encodeURIComponent(roleName)}`, accessToken, {
    public_key_pem: normalisedPem,
  });

  await logAuditEvent(data.rotated ? 'PROVIDER_PUBLIC_KEY_ROTATED' : 'PROVIDER_PUBLIC_KEY_REGISTERED', userId, {
    roleName,
    fingerprint_sha256: fingerprint,
    timestamp: new Date().toISOString(),
  });

  return { fingerprint };
}

/**
 * Whether the user has a public key registered in gov_layer.
 */
export async function getPublicKeyStatus({ roleName, accessToken }) {
  const data = await callGovLayer('GET', `/provider-keys/${encodeURIComponent(roleName)}/status`, accessToken);
  return { exists: Boolean(data.exists) };
}

async function callGovLayer(method, path, accessToken, body) {
  const res = await fetch(`${GOV_LAYER_URL}/api/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 400 && data?.error) {
    throw new InvalidPublicKeyError(data.error);
  }
  if (!res.ok || data?.status !== 'SUCCESS') {
    throw new Error(`gov_layer ${method} ${path} failed (${res.status}): ${data?.error || 'no response body'}`);
  }
  return data;
}
