import { generateKeyPairSync } from 'crypto';
import { getImmuDBClient, logAuditEvent } from './immudb.service.js';
import { getAdminToken, setUserAttribute } from './keycloak.service.js';

// The realm's Keycloak User Profile only persists attributes it has declared
// (undeclared ones are silently stripped on save) — "public-key" is the one
// already declared there.
const PUBLIC_KEY_ATTRIBUTE = 'public-key';

export const KEY_PAIR_ROLES = new Set(['data-provider', 'infra-provider']);

// One key pair per USER: Keycloak only has one "public-key" attribute slot,
// so a returning data-provider always reuses their existing key pair rather
// than generating a new one and overwriting the public key while the old
// private key stays on disk, leaving a mismatched pair.
function keyStoreKey(userId) {
  return `dp-keypair:${userId}`;
}

/**
 * Ensure a key pair exists for this user, right after a KEY_PAIR_ROLES role
 * (data-provider, infra-provider) is granted. If the user already has a key
 * pair, it's reused as-is — the public key is already on their Keycloak
 * profile. Otherwise a fresh RSA pair is generated: the public half published
 * to Keycloak immediately, the private half held in immuDB (never logged,
 * never returned from a list endpoint, never rendered).
 */
export async function provisionDataProviderKeyPair({ userId, roleName }) {
  if (!KEY_PAIR_ROLES.has(roleName)) {
    return null;
  }

  const existing = await getPrivateKeyRecord({ userId });
  if (existing?.private_key_pem) {
    const roles = Array.from(new Set([...(existing.roles || [existing.role_name].filter(Boolean)), roleName]));
    const client = getImmuDBClient();
    if (client && roles.length !== (existing.roles || []).length) {
      await client.set({ key: keyStoreKey(userId), value: JSON.stringify({ ...existing, roles }) });
    }
    return { publicKey: existing.public_key_pem };
  }

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const adminToken = await getAdminToken();
  await setUserAttribute(userId, PUBLIC_KEY_ATTRIBUTE, publicKey, adminToken);

  const client = getImmuDBClient();
  if (client) {
    const timestamp = Date.now();
    const record = {
      user_id: userId,
      roles: [roleName],
      public_key_pem: publicKey,
      private_key_pem: privateKey,
      created_at: timestamp,
      created_at_iso: new Date(timestamp).toISOString(),
      download_count: 0,
      last_downloaded_at: null,
    };
    await client.set({ key: keyStoreKey(userId), value: JSON.stringify(record) });
  }

  await logAuditEvent('DATA_PROVIDER_KEYPAIR_GENERATED', userId, {
    roleName,
    timestamp: new Date().toISOString(),
  });

  return { publicKey };
}

export async function getPrivateKeyRecord({ userId }) {
  const client = getImmuDBClient();
  if (!client) {
    return null;
  }

  try {
    const res = await client.get({ key: keyStoreKey(userId) });
    const value = res?.value;
    if (!value) {
      return null;
    }
    const json = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// The private key stays available for repeat downloads (the user may lose
// the file, switch machines, etc.) — this just tracks download history for
// audit purposes, it never removes the key from storage.
export async function recordPrivateKeyDownload({ userId }) {
  const client = getImmuDBClient();
  if (!client) {
    return;
  }

  const current = await getPrivateKeyRecord({ userId });
  if (!current) {
    return;
  }

  const timestamp = Date.now();
  const updated = {
    ...current,
    download_count: (current.download_count || 0) + 1,
    last_downloaded_at: timestamp,
  };

  await client.set({ key: keyStoreKey(userId), value: JSON.stringify(updated) });
}
