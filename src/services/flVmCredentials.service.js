import { createHash, timingSafeEqual } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { kvGet, kvScan, kvSet, logAuditEvent } from './immudb.service.js';

/**
 * FL client-VM credential records (Flotilla join gateway).
 *
 * One record per offline token issued to a data provider's FL VM. The token
 * itself and the provider's password are NEVER stored — only a fingerprint
 * (first 16 hex of sha256(offline token)) so /fl/vm-token can check that the
 * VM presents the token this record was issued for.
 *
 * immuDB keys:
 *   flvmcred:<id>                        → record JSON (latest version wins)
 *   flvmcred:sub:<submission_id>:<id>    → record JSON (per-session index)
 *   flvmcred:sid:<session_id>            → <id>  (Keycloak offline session → record)
 *
 * Reads fail closed: any store error is thrown so callers return 503 instead
 * of treating "can't read" as "no record".
 */

export const FL_VM_CREDENTIAL_STATES = Object.freeze(['issued', 'delivered', 'expired']);

export function tokenFingerprint(token) {
  return createHash('sha256').update(String(token || '')).digest('hex').slice(0, 16);
}

export function fingerprintMatches(token, fingerprint) {
  const a = Buffer.from(tokenFingerprint(token));
  const b = Buffer.from(String(fingerprint || ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

const defaultKv = { set: kvSet, get: kvGet, scan: kvScan };

export function createFlVmCredentialStore({
  kv = defaultKv,
  audit = logAuditEvent,
  now = () => Date.now(),
  newId = uuidv4,
} = {}) {
  async function writeRecord(record) {
    const json = JSON.stringify(record);
    await kv.set(`flvmcred:${record.credential_id}`, json);
    await kv.set(`flvmcred:sub:${record.submission_id}:${record.credential_id}`, json);
  }

  async function auditState(record) {
    try {
      await audit(`FL_VM_CREDENTIAL_${String(record.state).toUpperCase()}`, record.username, {
        credential_id: record.credential_id,
        submission_id: record.submission_id,
        fingerprint: record.token_fingerprint,
        ...(record.state_reason ? { reason: record.state_reason } : {}),
      });
    } catch {
      // audit is best-effort; the record itself is the source of truth
    }
  }

  async function get(credentialId) {
    if (!credentialId) return null;
    const raw = await kv.get(`flvmcred:${credentialId}`);
    if (!raw) return null;
    return JSON.parse(raw);
  }

  async function create({ submission_id, contract_id, username, user_id, session_id, expires_at, offline_token }) {
    const record = {
      credential_id: newId(),
      submission_id,
      contract_id,
      username,
      user_id,
      session_id,
      state: 'issued',
      issued_at: new Date(now()).toISOString(),
      expires_at,
      token_fingerprint: tokenFingerprint(offline_token),
    };
    await writeRecord(record);
    if (session_id) {
      await kv.set(`flvmcred:sid:${session_id}`, record.credential_id);
    }
    await auditState(record);
    return record;
  }

  async function findBySessionId(sessionId) {
    if (!sessionId) return null;
    const id = await kv.get(`flvmcred:sid:${sessionId}`);
    if (!id) return null;
    return get(id);
  }

  async function setState(credentialId, state, { reason } = {}) {
    if (!FL_VM_CREDENTIAL_STATES.includes(state)) {
      throw new Error(`INVALID_STATE: ${state}`);
    }
    const record = await get(credentialId);
    if (!record) return null;
    if (record.state === state) return record;
    const updated = {
      ...record,
      state,
      state_changed_at: new Date(now()).toISOString(),
      ...(reason ? { state_reason: reason } : {}),
    };
    await writeRecord(updated);
    await auditState(updated);
    return updated;
  }

  // Keycloak handed out a new refresh token on /fl/vm-token — the record now
  // only accepts the new one.
  async function updateFingerprint(credentialId, offlineToken) {
    const record = await get(credentialId);
    if (!record) return null;
    const updated = {
      ...record,
      token_fingerprint: tokenFingerprint(offlineToken),
      rotated_at: new Date(now()).toISOString(),
    };
    await writeRecord(updated);
    return updated;
  }

  async function listBySubmission(submissionId) {
    const entries = await kv.scan(`flvmcred:sub:${submissionId}:`);
    return entries
      .map(e => {
        try {
          return JSON.parse(e.value);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  return { get, create, findBySessionId, setState, updateFingerprint, listBySubmission };
}

const defaultStore = createFlVmCredentialStore();
export default defaultStore;
