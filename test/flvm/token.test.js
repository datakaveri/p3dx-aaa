import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setupWorld, signedFlContract, postJson } from './helpers.js';
import { tokenFingerprint } from '../../src/services/flVmCredentials.service.js';

let w;
before(async () => { w = await setupWorld(); });
after(async () => { await w.close(); });
beforeEach(() => {
  w.clock.t = Date.now();
  w.kc.state.forceSid = null;
  w.kc.state.deletes.length = 0;
});

let n = 0;
async function issued() {
  const sub = `sub-tok-${++n}`;
  w.gov.setContract(sub, signedFlContract(sub, { validUntil: new Date(Date.now() + 3_600_000).toISOString() }));
  const r = await w.issue('prov-a', sub);
  assert.equal(r.status, 200);
  const handed = w.orch.state.received.at(-1).body;
  return { credential_id: r.body.credential_id, offline_token: handed.offline_token, expires_at: r.body.expires_at };
}

const vmToken = body => postJson(w.app.url, '/p3dx/fl/vm-token', body);

test('refresh happy path: access token issued, rotation returned and fingerprint advanced', async () => {
  const c = await issued();
  const r = await vmToken({ credential_id: c.credential_id, offline_token: c.offline_token });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'SUCCESS');
  assert.ok(r.body.access_token);
  assert.equal(r.body.expires_in, 300);
  assert.equal(r.body.contract_valid_until, c.expires_at);
  assert.ok(r.body.offline_token && r.body.offline_token !== c.offline_token, 'rotated token returned');

  const rec = await w.store.get(c.credential_id);
  assert.equal(rec.token_fingerprint, tokenFingerprint(r.body.offline_token));

  // the new token works; the superseded one no longer matches the record
  const r2 = await vmToken({ credential_id: c.credential_id, offline_token: r.body.offline_token });
  assert.equal(r2.status, 200);
  const r3 = await vmToken({ credential_id: c.credential_id, offline_token: c.offline_token });
  assert.equal(r3.status, 401);
});

test('refresh after expires_at → 401 CREDENTIAL_EXPIRED, offline session deleted, record expired', async () => {
  const c = await issued();
  const rec = await w.store.get(c.credential_id);
  w.clock.t = Date.parse(c.expires_at) + 1;
  const r = await vmToken({ credential_id: c.credential_id, offline_token: c.offline_token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'CREDENTIAL_EXPIRED');
  assert.deepEqual(w.kc.state.deletes, [{ sid: rec.session_id, isOffline: 'true' }]);
  assert.equal(w.kc.state.sessions.get(rec.session_id).alive, false);
  assert.equal((await w.store.get(c.credential_id)).state, 'expired');
  assert.ok(w.auditEvents.some(e => e.type === 'FL_VM_CREDENTIAL_EXPIRED' && e.meta.credential_id === c.credential_id));
});

test('wrong fingerprint → 401, Keycloak never called', async () => {
  const c = await issued();
  const before = w.kc.state.issued.length;
  const r = await vmToken({ credential_id: c.credential_id, offline_token: c.offline_token + 'x' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'INVALID_CREDENTIAL');
  assert.equal(w.kc.state.issued.length, before);
});

test('unknown credential → 401 UNKNOWN_CREDENTIAL', async () => {
  const r = await vmToken({ credential_id: 'nope', offline_token: 'whatever' });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'UNKNOWN_CREDENTIAL');
});

test('sid mismatch → 401 SESSION_MISMATCH and no token returned', async () => {
  const c = await issued();
  w.kc.state.forceSid = 'some-other-session';
  const r = await vmToken({ credential_id: c.credential_id, offline_token: c.offline_token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'SESSION_MISMATCH');
  assert.equal(r.body.access_token, undefined);
});

test('Keycloak refresh failure → 401 REFRESH_FAILED', async () => {
  const c = await issued();
  const rec = await w.store.get(c.credential_id);
  w.kc.state.sessions.get(rec.session_id).alive = false;
  const r = await vmToken({ credential_id: c.credential_id, offline_token: c.offline_token });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'REFRESH_FAILED');
});

test('store unavailable → 503 (fail closed)', async () => {
  const c = await issued();
  w.kv.down = true;
  try {
    const r = await vmToken({ credential_id: c.credential_id, offline_token: c.offline_token });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, 'CREDENTIAL_STORE_UNAVAILABLE');
  } finally {
    w.kv.down = false;
  }
});

test('rate limit: 31st call within a minute → 429', async () => {
  const id = 'rate-limit-probe';
  for (let i = 0; i < 30; i++) {
    const r = await vmToken({ credential_id: id, offline_token: 't' });
    assert.equal(r.status, 401, `call ${i + 1}`);
  }
  const r = await vmToken({ credential_id: id, offline_token: 't' });
  assert.equal(r.status, 429);
  assert.equal(r.body.error, 'RATE_LIMITED');
  w.clock.t += 60_000;
  const r2 = await vmToken({ credential_id: id, offline_token: 't' });
  assert.equal(r2.status, 401, 'window resets after a minute');
});

test('VM access token is refused by verifyJWT-protected routes', async () => {
  const c = await issued();
  const r = await vmToken({ credential_id: c.credential_id, offline_token: c.offline_token });
  const again = await postJson(w.app.url, '/p3dx/fl/vm-credentials', { submission_id: 'x', password: 'y' }, { Authorization: `Bearer ${r.body.access_token}` });
  assert.equal(again.status, 403);
  assert.equal(again.body.error, 'VM_TOKEN_NOT_ALLOWED');
});

test('delivered callback: orchestrator service token marks delivered; others rejected', async () => {
  const c = await issued();
  const path = `/p3dx/internal/fl/vm-credentials/${c.credential_id}/delivered`;

  const userTok = await w.kc.mintUserToken('prov-a');
  let r = await postJson(w.app.url, path, {}, { Authorization: `Bearer ${userTok}` });
  assert.equal(r.status, 403);

  const wrongRole = await w.kc.mintToken({ sub: 'svc', azp: 'p3dx-fl-orchestrator', roles: ['user'] });
  r = await postJson(w.app.url, path, {}, { Authorization: `Bearer ${wrongRole}` });
  assert.equal(r.status, 403);

  r = await postJson(w.app.url, path, {});
  assert.equal(r.status, 401);

  const svc = await w.kc.mintToken({ sub: 'svc', azp: 'p3dx-fl-orchestrator', roles: ['fl-orchestrator'] });
  r = await postJson(w.app.url, path, {}, { Authorization: `Bearer ${svc}` });
  assert.equal(r.status, 200);
  assert.equal(r.body.state, 'delivered');
  assert.equal((await w.store.get(c.credential_id)).state, 'delivered');

  r = await postJson(w.app.url, '/p3dx/internal/fl/vm-credentials/nope/delivered', {}, { Authorization: `Bearer ${svc}` });
  assert.equal(r.status, 404);
});
