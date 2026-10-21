import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startKeycloakStub, setEnv, memoryKv } from './helpers.js';

let kc;
before(async () => { kc = await startKeycloakStub(); setEnv({ kc }); });
after(async () => { await kc.close(); });

test('sweeper deletes orphan + expired sessions, keeps live ones, marks records expired', async () => {
  const { createFlVmCredentialStore } = await import('../../src/services/flVmCredentials.service.js');
  const { sweepVmOfflineSessions } = await import('../../src/services/flVmSweeper.service.js');
  const t0 = Date.now();
  const store = createFlVmCredentialStore({ kv: memoryKv(), audit: async () => {}, now: () => t0 });

  const liveSid = kc.addSession('prov-a');
  const expiredSid = kc.addSession('prov-b');
  const orphanSid = kc.addSession('prov-x');
  const live = await store.create({ submission_id: 's', contract_id: 'c', username: 'prov-a', user_id: 'a', session_id: liveSid, expires_at: new Date(t0 + 3_600_000).toISOString(), offline_token: 'tok-live' });
  const expired = await store.create({ submission_id: 's', contract_id: 'c', username: 'prov-b', user_id: 'b', session_id: expiredSid, expires_at: new Date(t0 - 1).toISOString(), offline_token: 'tok-exp' });

  const summary = await sweepVmOfflineSessions({ store, now: () => t0 });
  assert.deepEqual(summary, { sessions: 3, kept: 1, orphansDeleted: 1, expiredDeleted: 1, skipped: 0, errors: 0 });

  assert.equal(kc.state.sessions.get(liveSid).alive, true);
  assert.equal(kc.state.sessions.get(expiredSid).alive, false);
  assert.equal(kc.state.sessions.get(orphanSid).alive, false);
  assert.equal((await store.get(live.credential_id)).state, 'issued');
  assert.equal((await store.get(expired.credential_id)).state, 'expired');

  // second pass: nothing left to do
  const again = await sweepVmOfflineSessions({ store, now: () => t0 });
  assert.deepEqual(again, { sessions: 1, kept: 1, orphansDeleted: 0, expiredDeleted: 0, skipped: 0, errors: 0 });
});

test('sweeper leaves sessions alone when the record store is unavailable', async () => {
  const { createFlVmCredentialStore } = await import('../../src/services/flVmCredentials.service.js');
  const { sweepVmOfflineSessions } = await import('../../src/services/flVmSweeper.service.js');
  const kv = memoryKv();
  kv.down = true;
  const store = createFlVmCredentialStore({ kv, audit: async () => {} });
  const sid = kc.addSession('prov-a');
  const summary = await sweepVmOfflineSessions({ store });
  assert.equal(summary.orphansDeleted, 0);
  assert.ok(summary.skipped >= 1);
  assert.equal(kc.state.sessions.get(sid).alive, true);
});

test('startFlVmSweeper never throws out of the timer', async () => {
  const { startFlVmSweeper } = await import('../../src/services/flVmSweeper.service.js');
  const logs = [];
  const orig = console.warn;
  console.warn = (...a) => logs.push(a.join(' '));
  try {
    const timer = startFlVmSweeper({
      intervalMs: 10,
      keycloak: { listVmOfflineSessions: async () => { throw new Error('keycloak down'); }, deleteOfflineSession: async () => {} },
    });
    await new Promise(r => setTimeout(r, 50));
    clearInterval(timer);
  } finally {
    console.warn = orig;
  }
  assert.ok(logs.some(l => l.includes('fl-vm-sweeper: sweep failed: keycloak down')));
  assert.equal(startFlVmSweeper({ intervalMs: 0 }), null);
});
