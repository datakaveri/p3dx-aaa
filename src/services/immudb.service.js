import pkg from 'immudb-node';
import { v4 as uuidv4 } from 'uuid';
import { createHash } from 'crypto';

const ImmudbClient = pkg.default;

let client;

async function scanAllByPrefix(prefix) {
  const results = [];
  let seekkey;

  for (;;) {
    const page = await client.scan({
      prefix,
      seekkey,
      limit: 1000,
    });

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

export async function initImmuDB() {
  const host = process.env.IMMUDB_HOST;
  const portRaw = process.env.IMMUDB_PORT;
  const user = process.env.IMMUDB_USER;
  const password = process.env.IMMUDB_PASSWORD;
  const database = process.env.IMMUDB_DATABASE;

  const port = Number.parseInt(portRaw, 10);
  if (!host || !portRaw || Number.isNaN(port) || !user || !password) {
    client = null;
    console.warn('⚠ immuDB env not fully configured. Audit logging will be console-only.');
    return;
  }

  try {
    client = new ImmudbClient({
      host,
      port,
    });

    await client.login({
      user,
      password,
    });

    if (database) {
      try {
        await client.useDatabase({
          databasename: database,
        });
        console.log('✓ immuDB connected and database selected');
      } catch (err) {
        if (err.message?.includes('NOT_FOUND') || err.message?.includes('does not exist')) {
          console.warn('⚠ immuDB database not found. Audit logging will be console-only.');
          console.warn(`  Database: ${database}`);
          console.warn('  To enable immuDB audit logging, create the database first.');
          client = null;
        } else {
          throw err;
        }
      }
    } else {
      console.warn('⚠ IMMUDB_DATABASE not set. Audit logging will be console-only.');
      client = null;
    }
  } catch (err) {
    client = null;
    console.warn('⚠ immuDB connection/login failed. Audit logging will be console-only.');
    console.warn(`  ${err.message}`);
  }
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
    await client.set({ key: `audit:${eventId}`, value: eventJson });
    
    // Store with event_type index for filtering
    await client.set({ key: `audit:type:${eventType}:${eventId}`, value: eventJson });
    
    // Store with subject_id index for user tracking
    await client.set({ key: `audit:subject:${subjectId}:${eventId}`, value: eventJson });
    
    // Store with timestamp for chronological querying
    await client.set({ key: `audit:time:${timestamp}:${eventId}`, value: eventJson });

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
