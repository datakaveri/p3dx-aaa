// Shared stubs for the FL VM credential tests: a fake Keycloak (token
// endpoint, JWKS, admin sessions API), a fake gov_layer, a fake orchestrator
// and an in-memory immuDB KV. No test framework code here.
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export const REALM = 'master';
export const VM_CLIENT_ID = 'flotilla-vm';
export const VM_SECRET = 'test-vm-client-secret';
export const INTERNAL_KEY = 'test-internal-key';
export const ADMIN_USER = 'admin';
export const ADMIN_PASSWORD = 'admin-test-pw';

export const USERS = {
  'prov-a': { id: '11111111-aaaa-4000-8000-000000000001', password: 'pw-A-Sup3rS3cret!' },
  'prov-b': { id: '11111111-bbbb-4000-8000-000000000002', password: 'pw-B-Sup3rS3cret!' },
  'prov-x': { id: '11111111-xxxx-4000-8000-000000000003', password: 'pw-X-Sup3rS3cret!' },
};

function listen(handler) {
  return new Promise(resolve => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => resolve(data));
  });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

export async function startKeycloakStub() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-kid', alg: 'RS256', use: 'sig' };

  const state = {
    sessions: new Map(),        // sid -> { userId, username, alive }
    refreshTokens: new Map(),   // token string -> sid
    deletes: [],                // sids passed to DELETE /sessions/:id
    forceSid: null,             // make refresh return a different sid
    loginDown: false,           // make the token endpoint 503
    issued: [],                 // every token string handed out (for leak checks)
  };

  async function sign(claims, { expiresIn = '5m' } = {}) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);
  }

  async function issueVmTokens(sid, sess, { accessSid } = {}) {
    const access = await sign({
      sub: sess.userId,
      preferred_username: sess.username,
      azp: VM_CLIENT_ID,
      sid: accessSid || sid,
      typ: 'Bearer',
      realm_access: { roles: ['offline_access', 'data-provider'] },
      jti: randomUUID(),
    });
    const refresh = await sign({ sub: sess.userId, azp: VM_CLIENT_ID, sid, typ: 'Offline', jti: randomUUID() }, { expiresIn: '30d' });
    state.refreshTokens.set(refresh, sid);
    state.issued.push(access, refresh);
    return { access_token: access, refresh_token: refresh, expires_in: 300, token_type: 'Bearer', scope: 'openid offline_access' };
  }

  const stub = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    if (req.method === 'GET' && p === `/realms/${REALM}/protocol/openid-connect/certs`) {
      return sendJson(res, 200, { keys: [jwk] });
    }

    if (req.method === 'POST' && p === `/realms/${REALM}/protocol/openid-connect/token`) {
      if (state.loginDown) return sendJson(res, 503, { error: 'unavailable' });
      const f = new URLSearchParams(await readBody(req));
      const grant = f.get('grant_type');
      const clientId = f.get('client_id');

      if (grant === 'password' && clientId === 'admin-cli') {
        if (f.get('username') !== ADMIN_USER || f.get('password') !== ADMIN_PASSWORD) {
          return sendJson(res, 401, { error: 'invalid_grant' });
        }
        return sendJson(res, 200, { access_token: 'stub-admin-token', expires_in: 60 });
      }

      if (clientId !== VM_CLIENT_ID || f.get('client_secret') !== VM_SECRET) {
        return sendJson(res, 401, { error: 'unauthorized_client' });
      }

      if (grant === 'password') {
        const user = USERS[f.get('username')];
        if (!user || user.password !== f.get('password')) {
          return sendJson(res, 401, { error: 'invalid_grant', error_description: 'Invalid user credentials' });
        }
        if (!String(f.get('scope') || '').split(' ').includes('offline_access')) {
          return sendJson(res, 400, { error: 'invalid_scope' });
        }
        const sid = randomUUID();
        const sess = { userId: user.id, username: f.get('username'), alive: true };
        state.sessions.set(sid, sess);
        return sendJson(res, 200, await issueVmTokens(sid, sess));
      }

      if (grant === 'refresh_token') {
        const sid = state.refreshTokens.get(f.get('refresh_token'));
        const sess = sid && state.sessions.get(sid);
        if (!sess || !sess.alive) {
          return sendJson(res, 400, { error: 'invalid_grant', error_description: 'Offline user session not found' });
        }
        return sendJson(res, 200, await issueVmTokens(sid, sess, { accessSid: state.forceSid }));
      }

      return sendJson(res, 400, { error: 'unsupported_grant_type' });
    }

    if (p.startsWith(`/admin/realms/${REALM}/`)) {
      if (req.headers.authorization !== 'Bearer stub-admin-token') return sendJson(res, 401, { error: 'unauthorized' });
      const rest = p.slice(`/admin/realms/${REALM}`.length);

      if (req.method === 'GET' && rest === '/clients') {
        const cid = u.searchParams.get('clientId');
        return sendJson(res, 200, cid === VM_CLIENT_ID ? [{ id: 'uuid-flotilla-vm', clientId: VM_CLIENT_ID }] : []);
      }
      if (req.method === 'GET' && rest === '/clients/uuid-flotilla-vm/offline-sessions') {
        const first = Number(u.searchParams.get('first') || 0);
        const max = Number(u.searchParams.get('max') || 100);
        const all = [...state.sessions.entries()]
          .filter(([, s]) => s.alive)
          .map(([id, s]) => ({ id, username: s.username, userId: s.userId, start: 0, lastAccess: 0 }));
        return sendJson(res, 200, all.slice(first, first + max));
      }
      const m = rest.match(/^\/sessions\/([^/]+)$/);
      if (req.method === 'DELETE' && m) {
        const sid = decodeURIComponent(m[1]);
        state.deletes.push({ sid, isOffline: u.searchParams.get('isOffline') });
        const sess = state.sessions.get(sid);
        if (!sess || !sess.alive || u.searchParams.get('isOffline') !== 'true') return sendJson(res, 404, { error: 'not found' });
        sess.alive = false;
        res.writeHead(204);
        return res.end();
      }
    }

    sendJson(res, 404, { error: 'stub: no route' });
  });

  // Create an offline session directly (sweeper tests / orphans).
  function addSession(username) {
    const sid = randomUUID();
    state.sessions.set(sid, { userId: USERS[username].id, username, alive: true });
    return sid;
  }

  async function mintToken({ sub, preferred_username, roles = [], azp = 'p3dx-frontend', sid } = {}) {
    const t = await sign({ sub, preferred_username, azp, sid, realm_access: { roles } });
    state.issued.push(t);
    return t;
  }

  async function mintUserToken(username, roles = ['user', 'data-provider']) {
    return mintToken({ sub: USERS[username].id, preferred_username: username, roles });
  }

  return { ...stub, state, addSession, mintToken, mintUserToken };
}

export function signedFlContract(submissionId, { validUntil = new Date(Date.now() + 86_400_000).toISOString(), technique = 'FL', parties = ['prov-a', 'prov-b'] } = {}) {
  return {
    status: 'SUCCESS',
    contract: {
      contract_id: `contract-${submissionId}`,
      version: 2,
      technique,
      lifecycle: { created_at: new Date().toISOString(), valid_from: new Date().toISOString(), valid_until: validUntil },
      parties: { data_providers: parties.map(name => ({ id: USERS[name].id, name })) },
    },
  };
}

export async function startGovStub() {
  const contracts = new Map(); // submission_id -> { contract: {status, contract}, signatures }
  const stub = await listen((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    let m = p.match(/^\/api\/v1\/contract\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const c = contracts.get(decodeURIComponent(m[1]));
      return c ? sendJson(res, 200, c.contract) : sendJson(res, 404, { error: 'not found' });
    }
    m = p.match(/^\/api\/v1\/contracts\/by-session\/([^/]+)\/signatures$/);
    if (req.method === 'GET' && m) {
      const c = contracts.get(decodeURIComponent(m[1]));
      return c ? sendJson(res, 200, c.signatures) : sendJson(res, 404, { error: 'not found' });
    }
    sendJson(res, 404, { error: 'stub: no route' });
  });
  function setContract(submissionId, contract, signatures = { signatures: 'matching', tee: 'can run' }) {
    contracts.set(submissionId, { contract, signatures });
  }
  return { ...stub, setContract };
}

export async function startOrchestratorStub() {
  const state = { received: [], status: 200 };
  const stub = await listen(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (req.method === 'POST' && p === '/p3dx/internal/vm-credentials') {
      const body = JSON.parse((await readBody(req)) || '{}');
      state.received.push({ headers: req.headers, body });
      return sendJson(res, state.status, state.status < 300 ? { status: 'SUCCESS' } : { error: 'boom' });
    }
    sendJson(res, 404, { error: 'stub: no route' });
  });
  return { ...stub, state };
}

export function memoryKv() {
  const map = new Map();
  return {
    map,
    down: false,
    async set(key, value) {
      if (this.down) throw new Error('IMMUDB_UNAVAILABLE');
      map.set(key, value);
    },
    async get(key) {
      if (this.down) throw new Error('IMMUDB_UNAVAILABLE');
      return map.has(key) ? map.get(key) : null;
    },
    async scan(prefix) {
      if (this.down) throw new Error('IMMUDB_UNAVAILABLE');
      return [...map.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
    },
  };
}

export function setEnv({ kc, gov, orch }) {
  process.env.KEYCLOAK_BASE_URL = kc.url;
  process.env.KEYCLOAK_REALM = REALM;
  process.env.KEYCLOAK_ADMIN_USER = ADMIN_USER;
  process.env.KEYCLOAK_ADMIN_PASSWORD = ADMIN_PASSWORD;
  process.env.FLOTILLA_VM_CLIENT_ID = VM_CLIENT_ID;
  process.env.FLOTILLA_VM_CLIENT_SECRET = VM_SECRET;
  process.env.ORCHESTRATOR_CLIENT_ID = 'p3dx-fl-orchestrator';
  if (gov) process.env.TOP_BASE_URL = `${gov.url}/api/v1`;
  if (orch) process.env.ORCHESTRATOR_SERVICE_URL = orch.url;
  process.env.INTERNAL_SERVICE_KEY = INTERNAL_KEY;
  for (const k of ['IMMUDB_HOST', 'IMMUDB_PORT', 'IMMUDB_USER', 'IMMUDB_PASSWORD', 'IMMUDB_DATABASE']) delete process.env[k];
}

// Mirrors src/app.js ordering: FL VM router before the app-wide parsers,
// the repo's real error middleware last.
export async function startApp(router) {
  const { default: errorMiddleware } = await import('../../src/middlewares/error.middleware.js');
  const app = express();
  app.use('/p3dx', router);
  app.use(express.json({ limit: '5mb' }));
  app.use(errorMiddleware);
  return listen(app);
}

export async function postJson(base, path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

// Builds the whole world: stubs + store + router + app, with a controllable clock.
export async function setupWorld() {
  const kc = await startKeycloakStub();
  const gov = await startGovStub();
  const orch = await startOrchestratorStub();
  setEnv({ kc, gov, orch });

  const clock = { t: Date.now() };
  const now = () => clock.t;
  const kv = memoryKv();
  const auditEvents = [];

  const { createFlVmCredentialStore } = await import('../../src/services/flVmCredentials.service.js');
  const { createFlVmRouter } = await import('../../src/routes/flVm.routes.js');
  const store = createFlVmCredentialStore({ kv, now, audit: async (type, subject, meta) => { auditEvents.push({ type, subject, meta }); } });
  const router = createFlVmRouter({ store, now });
  const app = await startApp(router);

  async function issue(username = 'prov-a', submissionId = 'sub-1', password = USERS[username].password) {
    const token = await kc.mintUserToken(username);
    return postJson(app.url, '/p3dx/fl/vm-credentials', { submission_id: submissionId, password }, { Authorization: `Bearer ${token}` });
  }

  async function close() {
    await Promise.all([kc.close(), gov.close(), orch.close(), app.close()]);
  }

  return { kc, gov, orch, app, clock, now, kv, store, auditEvents, issue, close };
}
