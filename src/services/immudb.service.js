import pkg from 'immudb-node';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

const ImmudbClient = pkg.default;

let client;
let initializationComplete = false;

async function scanAllByPrefix(prefix, c = client) {
  const results = [];
  let seekkey;

  for (;;) {
    const page = mustRespond(await c.scan({
      prefix,
      seekkey,
      limit: 1000,
    }));

    const entries = page?.entriesList || [];
    if (entries.length === 0) {
      break;
    }

    results.push(...entries);

    const lastKey = entries[entries.length - 1]?.key;
    if (!lastKey || lastKey === seekkey) {
      break;
    }

    seekkey = lastKey + '\u0000';
  }

  return results;
}

function readImmuDBEnv() {
  const host = process.env.IMMUDB_HOST;
  const portRaw = process.env.IMMUDB_PORT;
  const user = process.env.IMMUDB_USER;
  const password = process.env.IMMUDB_PASSWORD;
  const database = process.env.IMMUDB_DATABASE;
  const port = Number.parseInt(portRaw, 10);
  const configured = !!(host && portRaw && !Number.isNaN(port) && user && password);
  return { host, port, user, password, database, configured };
}

// Builds a fresh, logged-in client with the database selected. Throws on any
// failure (callers decide whether that's fatal).
async function connectClient({ host, port, user, password, database }) {
  const next = new ImmudbClient({ host, port });
  await next.login({ user, password });
  await next.useDatabase({ databasename: database });
  return next;
}

function closeClientQuietly(old) {
  try {
    old?.client?.close?.();
  } catch {
    // ignore — the channel is being replaced anyway
  }
}

export async function initImmuDB() {
  const cfg = readImmuDBEnv();

  if (!cfg.configured) {
    client = null;
    console.warn('⚠ immuDB env not fully configured. Audit logging will be console-only.');
    initializationComplete = true;
    return;
  }

  if (!cfg.database) {
    console.warn('⚠ IMMUDB_DATABASE not set. Audit logging will be console-only.');
    client = null;
    initializationComplete = true;
    return;
  }

  try {
    client = await connectClient(cfg);
    console.log('✓ immuDB connected and database selected');
  } catch (err) {
    client = null;
    const msg = errorText(err);
    if (msg.includes('NOT_FOUND') || msg.includes('does not exist')) {
      console.warn('⚠ immuDB database not found. Audit logging will be console-only.');
      console.warn(`  Database: ${cfg.database}`);
      console.warn('  To enable immuDB audit logging, create the database first.');
    } else {
      console.warn('⚠ immuDB connection/login failed. Audit logging will be console-only.');
      console.warn(`  ${msg}`);
    }
  }

  initializationComplete = true;
}

// immudb-node rejects with an Error on most calls but with a bare string on
// get() — normalise both.
function errorText(err) {
  if (typeof err === 'string') return err;
  return String(err?.message || err?.details || err || '');
}

// gRPC UNAVAILABLE (14) / UNAUTHENTICATED (16), or an immudb session/token
// that no longer exists after an immudb restart. The original client never
// recovered from these; withImmuReconnect() below re-inits once and retries.
function isConnectionError(err) {
  const code = typeof err === 'object' && err ? err.code : undefined;
  if (code === 14 || code === 16) return true;
  const msg = errorText(err);
  return /^1[46] |UNAVAILABLE|UNAUTHENTICATED|ECONNRESET|ECONNREFUSED|EPIPE|Connection dropped|connection closed|Channel has been shut down|session not found|invalid token|not logged in|no session|please login/i.test(msg);
}

export function isKeyNotFoundError(err) {
  return /key not found/i.test(errorText(err));
}

let reconnecting = null;

// Single-flight re-init: concurrent callers that all hit a stale connection
// share one reconnect attempt. Returns the new client or null.
export async function reconnectImmuDB() {
  if (reconnecting) return reconnecting;
  reconnecting = (async () => {
    const cfg = readImmuDBEnv();
    if (!cfg.configured || !cfg.database) return null;
    try {
      const next = await connectClient(cfg);
      const old = client;
      client = next;
      if (old && old !== next) closeClientQuietly(old);
      console.log('✓ immuDB reconnected');
      return client;
    } catch (err) {
      console.error(`✗ immuDB reconnect failed: ${errorText(err)}`);
      return null;
    }
  })();
  try {
    return await reconnecting;
  } finally {
    reconnecting = null;
  }
}

// Runs fn(client). With no client (immudb was down at startup) or on a
// connection-class error, re-inits the client once and retries. Anything
// else — or a second failure — is thrown to the caller.
async function withImmuReconnect(fn) {
  let c = client;
  if (!c) {
    c = await reconnectImmuDB();
    if (!c) {
      throw new Error('IMMUDB_UNAVAILABLE');
    }
    return fn(c);
  }
  try {
    return await fn(c);
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    const fresh = await reconnectImmuDB();
    if (!fresh) {
      throw new Error(`IMMUDB_UNAVAILABLE: ${errorText(err)}`);
    }
    return fn(fresh);
  }
}

/**
 * Generic KV helpers with reconnect-on-error. Unlike the audit helpers below
 * these never swallow errors: a caller that must fail closed (e.g. the FL VM
 * credential records) gets a throw when immuDB is unavailable.
 */
export async function kvSet(key, value) {
  await withImmuReconnect(async c => mustRespond(await c.set({ key, value })));
}

// Returns the latest value for key as a string, or null if the key doesn't
// exist. Throws on any other error.
export async function kvGet(key) {
  try {
    const resp = await withImmuReconnect(async c => mustRespond(await c.get({ key })));
    const value = resp?.value ?? null;
    if (value === null || value === undefined) return null;
    return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
  } catch (err) {
    if (isKeyNotFoundError(err)) return null;
    throw err instanceof Error ? err : new Error(errorText(err));
  }
}

// All {key, value} entries whose key starts with prefix (latest values).
// immudb-node catches synchronous failures (e.g. a closed gRPC channel),
// console.errors them and resolves undefined instead of rejecting. A real
// response is always an object, so treat undefined as a connection failure —
// otherwise a dead client would read as "key not found" (fail open).
function mustRespond(resp) {
  if (resp === undefined || resp === null) {
    const err = new Error('IMMUDB_NO_RESPONSE');
    err.code = 14;
    throw err;
  }
  return resp;
}

export async function kvScan(prefix) {
  return withImmuReconnect(c => scanAllByPrefix(prefix, c));
}

export function isImmuDBInitialized() {
  return initializationComplete;
}

/**
 * Log an audit event to immuDB
 * @param {string} eventType - Type of event (USER_REGISTER, USER_LOGIN, etc.)
 * @param {string} subjectId - Subject identifier (username, user ID, etc.)
 * @param {object} metadata - Additional event metadata
 * @returns {object} Event object that was logged
 */
export async function logAuditEvent(eventType, subjectId, metadata = {}) {
  if (!client) {
    console.warn('⚠ immuDB not initialized, skipping audit log');
    return null;
  }

  const timestamp = Date.now();
  const eventId = uuidv4();

  const event = {
    event_id: eventId,
    event_type: eventType,
    subject_id: subjectId,
    timestamp,
    occurred_at: new Date(timestamp).toISOString(),
    metadata: metadata,
  };

  try {
    // Log the audit event to immudb with multiple keys for querying flexibility
    const eventJson = JSON.stringify(event);
    
    // Store with event_id as primary key
    await kvSet(`audit:${eventId}`, eventJson);
    
    // Store with event_type index for filtering
    await kvSet(`audit:type:${eventType}:${eventId}`, eventJson);
    
    // Store with subject_id index for user tracking
    await kvSet(`audit:subject:${subjectId}:${eventId}`, eventJson);
    
    // Store with timestamp for chronological querying
    await kvSet(`audit:time:${timestamp}:${eventId}`, eventJson);

    console.log(`✓ ImmuDB audit logged [${eventType}] for ${subjectId} (ID: ${eventId})`);
    return event;
  } catch (err) {
    // If database selection failed, just log to console
    if (err.message?.includes('NOT_FOUND') || err.message?.includes('does not exist')) {
      console.log(`✓ Audit logged (console): ${eventType} for ${subjectId}`);
    } else {
      console.error(`✗ Failed to log audit event: ${err.message}`);
    }
    // Don't throw - audit logging shouldn't break the main flow
    return event;
  }
}

/**
 * Get all audit events from immuDB
 * @returns {array} Array of audit events
 */
export async function getAllAuditEvents() {
  if (!client) {
    console.warn('⚠ immuDB not initialized');
    return [];
  }

  try {
    const results = await scanAllByPrefix('audit:');

    return results
      .filter(entry => entry.key.match(/^audit:[a-f0-9-]+$/)) // Only primary keys
      .map(entry => {
        try {
          return JSON.parse(entry.value);
        } catch {
          return null;
        }
      })
      .filter(e => e !== null);
  } catch (err) {
    console.error(`✗ Failed to retrieve audit events: ${err.message}`);
    return [];
  }
}

/**
 * Get audit events by event type
 * @param {string} eventType - Type of events to retrieve
 * @returns {array} Filtered audit events
 */
export async function getAuditEventsByType(eventType) {
  if (!client) {
    console.warn('⚠ immuDB not initialized');
    return [];
  }

  try {
    const results = await scanAllByPrefix(`audit:type:${eventType}:`);

    return results
      .map(entry => {
        try {
          return JSON.parse(entry.value);
        } catch {
          return null;
        }
      })
      .filter(e => e !== null);
  } catch (err) {
    console.error(`✗ Failed to retrieve audit events by type: ${err.message}`);
    return [];
  }
}

/**
 * Get audit events by subject ID
 * @param {string} subjectId - Subject to retrieve events for
 * @returns {array} Filtered audit events
 */
export async function getAuditEventsBySubject(subjectId) {
  if (!client) {
    console.warn('⚠ immuDB not initialized');
    return [];
  }

  try {
    const results = await scanAllByPrefix(`audit:subject:${subjectId}:`);

    return results
      .map(entry => {
        try {
          return JSON.parse(entry.value);
        } catch {
          return null;
        }
      })
      .filter(e => e !== null);
  } catch (err) {
    console.error(`✗ Failed to retrieve audit events by subject: ${err.message}`);
    return [];
  }
}

export async function storeMaaTokens({ keycloakToken, userId, maaTokens, metadata = {} }) {
  const errors = [];

  if (!client) {
    console.warn('⚠ immuDB not initialized, skipping MAA token storage');
    errors.push('IMMUDB_NOT_INITIALIZED');
    return { stored: [], errors };
  }

  const tokens = Array.isArray(maaTokens) ? maaTokens : [];
  if (!keycloakToken || !userId || tokens.length === 0) {
    errors.push('INVALID_INPUT');
    return { stored: [], errors };
  }

  const timestamp = Date.now();
  const sessionHash = createHash('sha256').update(keycloakToken).digest('hex');

  const stored = [];

  for (const maaToken of tokens) {
    if (!maaToken) {
      continue;
    }

    const eventId = uuidv4();
    const record = {
      event_id: eventId,
      event_type: 'MAA_TOKEN_RECEIVED',
      user_id: userId,
      session_hash: sessionHash,
      timestamp,
      occurred_at: new Date(timestamp).toISOString(),
      keycloak_token: keycloakToken,
      maa_token: maaToken,
      metadata,
    };

    try {
      const recordJson = JSON.stringify(record);

      await client.set({ key: `maa:${eventId}`, value: recordJson });
      await client.set({ key: `maa:user:${userId}:${eventId}`, value: recordJson });
      await client.set({ key: `maa:session:${sessionHash}:${eventId}`, value: recordJson });
      await client.set({ key: `maa:time:${timestamp}:${eventId}`, value: recordJson });
      stored.push(record);
    } catch (err) {
      console.error(`✗ Failed to store MAA token record: ${err.message}`);
      errors.push(err.message);
    }
  }

  return { stored, errors };
}

export function getImmuDBClient() {
  return client;
}

export async function storeWorkloadContract({ contract, datasetId, applicationId, user, metadata = {} }) {
  const errors = [];

  if (!client) {
    console.warn('⚠ immuDB not initialized, skipping workload contract storage');
    errors.push('IMMUDB_NOT_INITIALIZED');
    return { stored: null, errors };
  }

  const contractId = contract?.contract_id || contract?.contractId;
  if (!contractId) {
    errors.push('MISSING_CONTRACT_ID');
    return { stored: null, errors };
  }

  const userSub = user?.sub || user?.id || user?.user_id || user?.preferred_username || 'unknown';
  const userEmail = user?.email;
  const timestamp = Date.now();

  const contractJson = JSON.stringify(contract);
  const contractHash = createHash('sha256').update(contractJson).digest('hex');

  const record = {
    event_id: uuidv4(),
    event_type: 'WORKLOAD_CONTRACT_CREATED',
    contract_id: contractId,
    contract_hash: contractHash,
    dataset_id: datasetId,
    application_id: applicationId,
    user_sub: userSub,
    user_email: userEmail,
    timestamp,
    occurred_at: new Date(timestamp).toISOString(),
    contract,
    metadata,
  };

  try {
    const recordJson = JSON.stringify(record);

    await client.set({ key: `workload-contract:${contractId}`, value: recordJson });
    await client.set({ key: `workload-contract:user:${userSub}:${contractId}`, value: recordJson });
    await client.set({ key: `workload-contract:time:${timestamp}:${contractId}`, value: recordJson });
    if (datasetId) {
      await client.set({ key: `workload-contract:dataset:${datasetId}:${contractId}`, value: recordJson });
    }
    if (applicationId) {
      await client.set({ key: `workload-contract:app:${applicationId}:${contractId}`, value: recordJson });
    }

    return { stored: record, errors };
  } catch (err) {
    console.error(`✗ Failed to store workload contract record: ${err.message}`);
    errors.push(err.message);
    return { stored: record, errors };
  }
}

export async function getWorkloadContractById(contractId) {
  if (!client) {
    return null;
  }

  if (!contractId) {
    return null;
  }

  try {
    const resp = await client.get({ key: `workload-contract:${contractId}` });
    const value = resp?.value ?? resp;
    if (!value) {
      return null;
    }

    const json = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    return JSON.parse(json);
  } catch {
    return null;
  }
}
