import { v4 as uuidv4 } from 'uuid';
import { getImmuDBClient, logAuditEvent } from './immudb.service.js';

// data-provider is the single common role for data providers across FL, SMPC, and DP.
// output-owner is not a requestable role — any non-data-provider user gets
// the FL output-owner workflow automatically (see FederatedLearning.jsx).
const ALLOWED_ROLES = new Set(['application-provider', 'data-provider']);

function ensureAllowedRole(roleName) {
  if (!ALLOWED_ROLES.has(roleName)) {
    const err = new Error('ROLE_NOT_ALLOWED');
    err.details = { roleName };
    throw err;
  }
}

async function scanAllByPrefix(client, prefix) {
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

function parseEntryValue(entry) {
  if (!entry?.value) {
    return null;
  }

  try {
    return JSON.parse(entry.value);
  } catch {
    return null;
  }
}

export async function createRoleRequest({ userId, roleName, requestedBy }) {
  ensureAllowedRole(roleName);

  const client = getImmuDBClient();
  if (!client) {
    const err = new Error('IMMUDB_NOT_INITIALIZED');
    throw err;
  }

  const existing = await getLatestRoleRequestByUserAndRole({ userId, roleName });
  if (existing?.status === 'APPROVED') {
    const err = new Error('ROLE_ALREADY_GRANTED');
    err.details = { roleName };
    throw err;
  }

  // Every role now goes through admin approval — a second request while one
  // is already PENDING is rejected.
  if (existing?.status === 'PENDING') {
    const err = new Error('ROLE_REQUEST_ALREADY_PENDING');
    err.details = { roleName };
    throw err;
  }

  const requestId = uuidv4();
  const timestamp = Date.now();
  const timestampIso = new Date(timestamp).toISOString();
  const status = 'PENDING';

  const record = {
    request_id: requestId,
    user_id: userId,
    role_name: roleName,
    status,
    created_at: timestamp,
    created_at_iso: timestampIso,
    requested_by: requestedBy,
  };

  const json = JSON.stringify(record);

  await client.set({ key: `role-request:${requestId}`, value: json });
  await client.set({ key: `role-request:user:${userId}:${requestId}`, value: json });
  await client.set({ key: `role-request:role:${roleName}:${requestId}`, value: json });
  await client.set({ key: `role-request:status:${status}:${requestId}`, value: json });

  await logAuditEvent('ROLE_REQUEST_CREATED', userId, {
    requestId,
    roleName,
    requestedBy,
    timestamp: timestampIso,
  });

  return record;
}

export async function listRoleRequests({ status } = {}) {
  const client = getImmuDBClient();
  if (!client) {
    return [];
  }

  const prefix = status
    ? `role-request:status:${status.toUpperCase()}:`
    : 'role-request:';

  const results = await scanAllByPrefix(client, prefix);

  const requestedStatus = status ? String(status).toUpperCase() : null;

  let requests;
  if (requestedStatus) {
    const ids = results
      .map(entry => String(entry?.key || ''))
      .map(key => {
        const parts = key.split(':');
        return parts[parts.length - 1];
      })
      .filter(Boolean);

    const uniqueIds = Array.from(new Set(ids));
    const canonical = await Promise.all(uniqueIds.map(requestId => getRoleRequestById({ requestId })));
    requests = canonical
      .filter(Boolean)
      .filter(r => String(r.status || '').toUpperCase() === requestedStatus);
  } else {
    requests = results
      .filter(entry => /^role-request:[a-f0-9-]+$/.test(entry?.key || ''))
      .map(parseEntryValue)
      .filter(Boolean);
  }

  requests.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return requests;
}

export async function listRoleRequestsForUser({ userId }) {
  const client = getImmuDBClient();
  if (!client) {
    return [];
  }

  const results = await scanAllByPrefix(client, `role-request:user:${userId}:`);
  const requests = results.map(parseEntryValue).filter(Boolean);
  requests.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return requests;
}

export async function getRoleRequestById({ requestId }) {
  const client = getImmuDBClient();
  if (!client) {
    return null;
  }

  try {
    const res = await client.get({ key: `role-request:${requestId}` });
    const value = res?.value;
    if (!value) {
      return null;
    }

    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export async function getLatestRoleRequestByUserAndRole({ userId, roleName }) {
  ensureAllowedRole(roleName);

  const client = getImmuDBClient();
  if (!client) {
    return null;
  }

  const results = await scanAllByPrefix(client, `role-request:user:${userId}:`);
  const requests = results
    .map(parseEntryValue)
    .filter(r => r && r.role_name === roleName);

  requests.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  return requests[0] || null;
}

export async function decideRoleRequest({ requestId, decision, decidedBy }) {
  const client = getImmuDBClient();
  if (!client) {
    const err = new Error('IMMUDB_NOT_INITIALIZED');
    throw err;
  }

  const current = await getRoleRequestById({ requestId });
  if (!current) {
    const err = new Error('ROLE_REQUEST_NOT_FOUND');
    throw err;
  }

  if (current.status !== 'PENDING') {
    const err = new Error('ROLE_REQUEST_NOT_PENDING');
    err.details = { status: current.status };
    throw err;
  }

  const normalizedDecision = String(decision || '').toUpperCase();
  if (normalizedDecision !== 'APPROVE' && normalizedDecision !== 'REJECT') {
    const err = new Error('INVALID_DECISION');
    throw err;
  }

  const nextStatus = normalizedDecision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const timestamp = Date.now();

  const updated = {
    ...current,
    status: nextStatus,
    decided_at: timestamp,
    decided_at_iso: new Date(timestamp).toISOString(),
    decided_by: decidedBy,
  };

  const json = JSON.stringify(updated);

  await client.set({ key: `role-request:${requestId}`, value: json });
  await client.set({ key: `role-request:user:${updated.user_id}:${requestId}`, value: json });
  await client.set({ key: `role-request:role:${updated.role_name}:${requestId}`, value: json });

  await client.set({ key: `role-request:status:${nextStatus}:${requestId}`, value: json });

  await logAuditEvent('ROLE_REQUEST_DECIDED', updated.user_id, {
    requestId,
    roleName: updated.role_name,
    decision: normalizedDecision,
    decidedBy,
    timestamp: updated.decided_at_iso,
  });

  return updated;
}
