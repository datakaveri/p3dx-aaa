import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { startKeycloakStub, setEnv, postJson } from './helpers.js';

let kc;
let app;
before(async () => {
  kc = await startKeycloakStub();
  setEnv({ kc });
  const { verifyJWT } = await import('../../src/middlewares/auth.middleware.js');
  const a = express();
  a.post('/protected', verifyJWT, (req, res) => res.json({ ok: true, sub: req.user.sub }));
  app = await new Promise(resolve => {
    const s = a.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${s.address().port}`, close: () => new Promise(r => { s.closeAllConnections?.(); s.close(() => r()); }) }));
  });
});
after(async () => { await app.close(); await kc.close(); });

test('verifyJWT rejects a flotilla-vm token (azp) with 403 VM_TOKEN_NOT_ALLOWED', async () => {
  const t = await kc.mintToken({ sub: 'u1', preferred_username: 'prov-a', azp: 'flotilla-vm', roles: ['data-provider', 'offline_access'] });
  const r = await postJson(app.url, '/protected', {}, { Authorization: `Bearer ${t}` });
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { status: 'FAILED', error: 'VM_TOKEN_NOT_ALLOWED' });
});

test('verifyJWT still accepts a normal user token', async () => {
  const t = await kc.mintToken({ sub: 'u1', preferred_username: 'prov-a', azp: 'p3dx-frontend', roles: ['data-provider'] });
  const r = await postJson(app.url, '/protected', {}, { Authorization: `Bearer ${t}` });
  assert.equal(r.status, 200);
  assert.equal(r.body.sub, 'u1');
});
