import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatWithOptions } from 'node:util';
import { setupWorld, signedFlContract, USERS, postJson } from './helpers.js';

// Runs every path (success and failure) with console output captured, then
// asserts no password and no token string issued by the Keycloak stub ever
// appeared in any log line.
test('no password or token ever reaches console output', async () => {
  const lines = [];
  const orig = {};
  const methods = ['log', 'info', 'warn', 'error', 'debug'];
  for (const m of methods) {
    orig[m] = console[m];
    // Same rendering console uses (util.format), but with unlimited depth so
    // nested objects like an axios error's config.data are fully expanded.
    console[m] = (...args) => { lines.push(formatWithOptions({ depth: Infinity }, ...args)); };
  }

  let w;
  try {
    w = await setupWorld();
    w.gov.setContract('sub-log', signedFlContract('sub-log'));

    // success + refresh + rotation
    const ok = await w.issue('prov-a', 'sub-log');
    assert.equal(ok.status, 200);
    const handed = w.orch.state.received.at(-1).body;
    const t1 = await postJson(w.app.url, '/p3dx/fl/vm-token', { credential_id: ok.body.credential_id, offline_token: handed.offline_token });
    assert.equal(t1.status, 200);
    // wrong fingerprint (old token), session mismatch, refresh failure
    await postJson(w.app.url, '/p3dx/fl/vm-token', { credential_id: ok.body.credential_id, offline_token: handed.offline_token });
    w.kc.state.forceSid = 'x';
    await postJson(w.app.url, '/p3dx/fl/vm-token', { credential_id: ok.body.credential_id, offline_token: t1.body.offline_token });
    w.kc.state.forceSid = null;
    // wrong password, keycloak down, handoff failure
    await w.issue('prov-a', 'sub-log', 'definitely-wrong-pw-123');
    w.kc.state.loginDown = true;
    await w.issue('prov-b', 'sub-log');
    w.kc.state.loginDown = false;
    w.orch.state.status = 500;
    await w.issue('prov-b', 'sub-log');
    w.orch.state.status = 200;
    // malformed JSON bodies containing secrets
    const userTok = await w.kc.mintUserToken('prov-a');
    await postJson(w.app.url, '/p3dx/fl/vm-credentials', `{"submission_id":"sub-log","password":"${USERS['prov-a'].password}"`, { Authorization: `Bearer ${userTok}` });
    await postJson(w.app.url, '/p3dx/fl/vm-token', `{"credential_id":"a","offline_token":"${t1.body.offline_token}"`);
    // expiry path
    w.clock.t = Date.parse(ok.body.expires_at) + 1;
    await postJson(w.app.url, '/p3dx/fl/vm-token', { credential_id: ok.body.credential_id, offline_token: t1.body.offline_token });
  } finally {
    for (const m of methods) console[m] = orig[m];
    if (w) await w.close();
  }

  const secrets = [
    ...Object.values(USERS).map(u => u.password),
    'definitely-wrong-pw-123',
    'test-vm-client-secret',
    'admin-test-pw',
    'test-internal-key',
    ...w.kc.state.issued,
  ];
  const output = lines.join('\n');
  assert.ok(lines.length > 0, 'captured some log output');
  for (const s of secrets) {
    assert.ok(!output.includes(s), `secret leaked into logs: ${s.slice(0, 12)}…`);
    // also catch a token split across a JSON-escaped rendering
    assert.ok(!output.includes(s.slice(0, 40)), `secret prefix leaked into logs: ${s.slice(0, 12)}…`);
  }
});
