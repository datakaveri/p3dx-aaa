import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupWorld, signedFlContract, USERS, INTERNAL_KEY, postJson } from './helpers.js';
import { tokenFingerprint } from '../../src/services/flVmCredentials.service.js';

let w;
let validUntil;
before(async () => { w = await setupWorld(); });
after(async () => { await w.close(); });
beforeEach(() => {
  w.clock.t = Date.now();
  w.orch.state.received.length = 0;
  w.orch.state.status = 200;
  w.kc.state.deletes.length = 0;
  process.env.INTERNAL_SERVICE_KEY = INTERNAL_KEY;
  validUntil = new Date(Date.now() + 86_400_000).toISOString();
  w.gov.setContract('sub-1', signedFlContract('sub-1', { validUntil }));
});

test('issue happy path: response carries only credential_id/expires_at, orchestrator gets the offline token', async () => {
  const r = await w.issue('prov-a', 'sub-1');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['credential_id', 'expires_at', 'status']);
  assert.equal(r.body.status, 'SUCCESS');

  assert.equal(r.body.expires_at, validUntil, 'expires_at = contract lifecycle.valid_until');

  assert.equal(w.orch.state.received.length, 1);
  const { headers, body } = w.orch.state.received[0];
  assert.equal(headers['x-internal-key'], INTERNAL_KEY);
  assert.equal(body.credential_id, r.body.credential_id);
  assert.equal(body.submission_id, 'sub-1');
  assert.equal(body.contract_id, 'contract-sub-1');
  assert.equal(body.username, 'prov-a');
  assert.equal(body.user_id, USERS['prov-a'].id);
  assert.equal(body.expires_at, r.body.expires_at);
  assert.ok(body.offline_token && w.kc.state.refreshTokens.has(body.offline_token), 'orchestrator received the Keycloak offline token');

  const rec = await w.store.get(r.body.credential_id);
  assert.equal(rec.state, 'issued');
  assert.equal(rec.token_fingerprint, tokenFingerprint(body.offline_token));
  assert.equal(rec.session_id, w.kc.state.refreshTokens.get(body.offline_token));
  assert.equal((await w.store.findBySessionId(rec.session_id)).credential_id, rec.credential_id);

  // nothing secret persisted
  const dump = [...w.kv.map.values()].join('\n');
  assert.ok(!dump.includes(body.offline_token));
  assert.ok(!dump.includes(USERS['prov-a'].password));
  assert.ok(w.auditEvents.some(e => e.type === 'FL_VM_CREDENTIAL_ISSUED' && e.subject === 'prov-a'));
});

test('username comes from the token, not the body', async () => {
  const token = await w.kc.mintUserToken('prov-a');
  const r = await postJson(w.app.url, '/p3dx/fl/vm-credentials',
    { submission_id: 'sub-1', password: USERS['prov-b'].password, username: 'prov-b' },
    { Authorization: `Bearer ${token}` });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_CREDENTIALS');
});

test('caller not a contract party → 403', async () => {
  const r = await w.issue('prov-x', 'sub-1');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'NOT_A_CONTRACT_PARTY');
  assert.equal(w.orch.state.received.length, 0);
});

test('contract not fully signed → 409', async () => {
  w.gov.setContract('sub-1', signedFlContract('sub-1'), { signatures: 'not matching', tee: 'cannot run' });
  const r = await w.issue('prov-a', 'sub-1');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'CONTRACT_NOT_SIGNED');
});

test('non-FL contract → 409', async () => {
  w.gov.setContract('sub-1', signedFlContract('sub-1', { technique: 'TEE' }));
  const r = await w.issue('prov-a', 'sub-1');
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'NOT_AN_FL_CONTRACT');
});

test('expired contract → 410', async () => {
  w.gov.setContract('sub-1', signedFlContract('sub-1', { validUntil: new Date(Date.now() - 1000).toISOString() }));
  const r = await w.issue('prov-a', 'sub-1');
  assert.equal(r.status, 410);
  assert.equal(r.body.error, 'CONTRACT_EXPIRED');
});

test('unknown submission → 404', async () => {
  const r = await w.issue('prov-a', 'no-such-sub');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'CONTRACT_NOT_FOUND');
});

test('wrong password → 401 INVALID_CREDENTIALS', async () => {
  const r = await w.issue('prov-a', 'sub-1', 'wrong-password');
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_CREDENTIALS');
  assert.equal(w.orch.state.received.length, 0);
});

test('handoff failure → offline session deleted, record expired, 502', async () => {
  w.orch.state.status = 500;
  const r = await w.issue('prov-a', 'sub-1');
  assert.equal(r.status, 502);
  assert.equal(r.body.error, 'HANDOFF_FAILED');
  assert.equal(r.body.credential_id, undefined);

  const sent = w.orch.state.received[0].body;
  const sid = w.kc.state.refreshTokens.get(sent.offline_token);
  assert.deepEqual(w.kc.state.deletes, [{ sid, isOffline: 'true' }]);
  assert.equal(w.kc.state.sessions.get(sid).alive, false);
  const rec = await w.store.get(sent.credential_id);
  assert.equal(rec.state, 'expired');
  assert.equal(rec.state_reason, 'HANDOFF_FAILED');
});

test('INTERNAL_SERVICE_KEY empty → 503 INTERNAL_KEY_NOT_CONFIGURED', async () => {
  process.env.INTERNAL_SERVICE_KEY = '';
  const r = await w.issue('prov-a', 'sub-1');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'INTERNAL_KEY_NOT_CONFIGURED');
});

test('record store down → 503 and the fresh offline session is deleted', async () => {
  w.kv.down = true;
  try {
    const r = await w.issue('prov-a', 'sub-1');
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'CREDENTIAL_STORE_UNAVAILABLE');
    assert.equal(w.kc.state.deletes.length, 1);
    assert.equal(w.orch.state.received.length, 0);
  } finally {
    w.kv.down = false;
  }
});

test('missing token → 401; non-provider role → 403', async () => {
  let r = await postJson(w.app.url, '/p3dx/fl/vm-credentials', { submission_id: 'sub-1', password: 'x' });
  assert.equal(r.status, 401);
  const t = await w.kc.mintUserToken('prov-a', ['user']);
  r = await postJson(w.app.url, '/p3dx/fl/vm-credentials', { submission_id: 'sub-1', password: 'x' }, { Authorization: `Bearer ${t}` });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'INSUFFICIENT_ROLE');
});
