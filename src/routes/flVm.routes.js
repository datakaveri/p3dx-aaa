import express, { Router } from 'express';
import axios from 'axios';
import { decodeJwt } from 'jose';
import { verifyJWT, verifyServiceToken } from '../middlewares/auth.middleware.js';
import { requireAnyRole } from '../middlewares/role.middleware.js';
import {
  loginForVmOfflineToken,
  refreshVmToken,
  deleteOfflineSession,
} from '../services/keycloak.service.js';
import { getSessionContract, getSessionContractSignatures } from '../services/top.service.js';
import defaultStore, { fingerprintMatches } from '../services/flVmCredentials.service.js';

/**
 * Flotilla FL client-VM credentials (join gateway).
 *
 *   POST /p3dx/fl/vm-credentials                       (provider, verifyJWT)
 *     Provider re-enters their P3DX password; aaa does a flotilla-vm password
 *     grant for an OFFLINE token, records it (fingerprint only), and hands
 *     the token straight to p3dx-fl-orchestrator for the VM sidecar. The
 *     browser only ever gets back {credential_id, expires_at}.
 *
 *   POST /p3dx/fl/vm-token                             (VM sidecar, no user JWT)
 *     The ONLY place a VM can turn its offline token into an access token.
 *     Valid until the session's FL contract lifecycle.valid_until.
 *
 *   POST /p3dx/internal/fl/vm-credentials/:id/delivered (orchestrator service token)
 *
 * SECURITY: request bodies here carry a password or an offline token. Never
 * log req.body, Keycloak responses or axios errors whole (err.config.data
 * holds the request body) — only err.message / status codes. This router
 * also brings its own JSON parser + error handler (mounted ahead of the
 * app-wide parser, see app.js) so a malformed body is never dumped by the
 * global error middleware.
 */

const RATE_LIMIT_PER_MINUTE = 30;

function vmClientId() {
  return String(process.env.FLOTILLA_VM_CLIENT_ID || 'flotilla-vm').trim();
}

function orchestratorClientId() {
  return String(process.env.ORCHESTRATOR_CLIENT_ID || 'p3dx-fl-orchestrator').trim();
}

function orchestratorServiceUrl() {
  return String(process.env.ORCHESTRATOR_SERVICE_URL || 'http://localhost:3002').trim().replace(/\/+$/, '');
}

function internalServiceKey() {
  return String(process.env.INTERNAL_SERVICE_KEY || '').trim();
}

function fail(res, status, error, message) {
  return res.status(status).json({ status: 'FAILED', error, ...(message ? { message } : {}) });
}

// Fixed one-minute window per key. Entries are pruned lazily.
export function createRateLimiter({ limit = RATE_LIMIT_PER_MINUTE, windowMs = 60_000, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    if (hits.size > 10_000) {
      for (const [k, v] of hits) {
        if (t - v.start >= windowMs) hits.delete(k);
      }
    }
    const entry = hits.get(key);
    if (!entry || t - entry.start >= windowMs) {
      hits.set(key, { start: t, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

function isFlVmPath(p) {
  return p === '/fl/vm-credentials' || p === '/fl/vm-token' || /^\/internal\/fl\/vm-credentials\/[^/]+\/delivered$/.test(p);
}

function safeDecode(token) {
  try {
    return decodeJwt(token);
  } catch {
    return null;
  }
}

function errSummary(err) {
  // Deliberately NOT the error object: axios errors carry the request body.
  const status = err?.response?.status;
  const kcError = typeof err?.response?.data?.error === 'string' ? err.response.data.error : undefined;
  return [err?.message || 'error', status ? `status=${status}` : null, kcError ? `kc=${kcError}` : null]
    .filter(Boolean)
    .join(' ');
}

export function createFlVmRouter(deps = {}) {
  const {
    store = defaultStore,
    keycloak = { loginForVmOfflineToken, refreshVmToken, deleteOfflineSession },
    gov = { getSessionContract, getSessionContractSignatures },
    http = axios,
    authenticate = verifyJWT,
    authorizeProvider = requireAnyRole(['data-provider', 'fl-data-provider']),
    authenticateOrchestrator = verifyServiceToken(orchestratorClientId, 'fl-orchestrator'),
    now = () => Date.now(),
    rateLimiter = createRateLimiter({ now }),
  } = deps;

  const router = Router();
  const jsonBody = express.json({ limit: '32kb' });

  async function dropOfflineSession(sessionId, context) {
    try {
      await keycloak.deleteOfflineSession(sessionId);
      return true;
    } catch (err) {
      console.error(`[P3DX_STEP_WARN] ${context}: offline session delete failed:`, errSummary(err));
      return false;
    }
  }

  // ------------------------------------------------------------------------
  // POST /fl/vm-credentials — provider issues an offline credential for their VM
  // ------------------------------------------------------------------------
  router.post('/fl/vm-credentials', jsonBody, authenticate, authorizeProvider, async (req, res) => {
    try {
      if (!internalServiceKey()) {
        return fail(res, 503, 'INTERNAL_KEY_NOT_CONFIGURED', 'INTERNAL_SERVICE_KEY must be set to hand credentials to the orchestrator');
      }

      const submissionId = typeof req.body?.submission_id === 'string' ? req.body.submission_id.trim() : '';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      if (!submissionId || !password) {
        return fail(res, 400, 'INVALID_REQUEST', 'submission_id and password are required');
      }

      const userSub = req.user?.sub;
      const username = req.user?.preferred_username;
      if (!userSub || !username) {
        return fail(res, 401, 'INVALID_OR_EXPIRED_TOKEN', 'token has no sub/preferred_username');
      }

      // 1. Contract + signatures from gov_layer.
      let contractResp;
      let signatures;
      try {
        [contractResp, signatures] = await Promise.all([
          gov.getSessionContract({ sessionId: submissionId }),
          gov.getSessionContractSignatures({ sessionId: submissionId }),
        ]);
      } catch (err) {
        if (err?.statusCode === 404) {
          return fail(res, 404, 'CONTRACT_NOT_FOUND');
        }
        console.error('[P3DX_STEP_WARN] fl/vm-credentials: gov_layer lookup failed:', err?.message || 'error');
        return fail(res, 502, 'GOV_LAYER_ERROR', 'could not read the session contract');
      }

      const contract = contractResp?.contract;
      if (!contract) {
        return fail(res, 404, 'CONTRACT_NOT_FOUND');
      }
      if (signatures?.tee !== 'can run') {
        return fail(res, 409, 'CONTRACT_NOT_SIGNED', 'the session contract is not fully signed');
      }
      if (contract.technique !== 'FL') {
        return fail(res, 409, 'NOT_AN_FL_CONTRACT');
      }
      const providers = Array.isArray(contract?.parties?.data_providers) ? contract.parties.data_providers : [];
      if (!providers.some(p => p?.id && p.id === userSub)) {
        return fail(res, 403, 'NOT_A_CONTRACT_PARTY');
      }
      const validUntil = contract?.lifecycle?.valid_until;
      const validUntilMs = Date.parse(validUntil);
      if (!validUntil || Number.isNaN(validUntilMs)) {
        return fail(res, 409, 'CONTRACT_NO_VALIDITY', 'contract has no lifecycle.valid_until');
      }
      if (now() >= validUntilMs) {
        return fail(res, 410, 'CONTRACT_EXPIRED');
      }

      // 2. Offline token — username comes from the verified token, never the body.
      let kc;
      try {
        kc = await keycloak.loginForVmOfflineToken(username, password);
      } catch (err) {
        const status = err?.response?.status;
        if (status === 400 || status === 401) {
          return fail(res, 401, 'INVALID_CREDENTIALS');
        }
        console.error('[P3DX_STEP_WARN] fl/vm-credentials: keycloak login failed:', errSummary(err));
        return fail(res, 502, 'KEYCLOAK_ERROR');
      }

      const access = safeDecode(kc?.access_token);
      const refresh = safeDecode(kc?.refresh_token);
      const sessionId = access?.sid || refresh?.sid;
      if (!access || access.sub !== userSub) {
        await dropOfflineSession(sessionId, 'fl/vm-credentials');
        return fail(res, 403, 'SUBJECT_MISMATCH');
      }
      if (!refresh || refresh.typ !== 'Offline' || !sessionId) {
        await dropOfflineSession(sessionId, 'fl/vm-credentials');
        console.error('[P3DX_STEP_WARN] fl/vm-credentials: Keycloak did not return an offline token', { typ: refresh?.typ });
        return fail(res, 502, 'NOT_OFFLINE_TOKEN');
      }

      // 3. Record (fingerprint only).
      let record;
      try {
        record = await store.create({
          submission_id: submissionId,
          contract_id: contract.contract_id,
          username,
          user_id: userSub,
          session_id: sessionId,
          expires_at: new Date(validUntilMs).toISOString(),
          offline_token: kc.refresh_token,
        });
      } catch (err) {
        console.error('[P3DX_STEP_WARN] fl/vm-credentials: record store failed:', err?.message || 'error');
        await dropOfflineSession(sessionId, 'fl/vm-credentials');
        return fail(res, 503, 'CREDENTIAL_STORE_UNAVAILABLE');
      }

      // 4. Hand off to the orchestrator.
      try {
        const resp = await http.post(
          `${orchestratorServiceUrl()}/p3dx/internal/vm-credentials`,
          {
            credential_id: record.credential_id,
            submission_id: submissionId,
            contract_id: contract.contract_id,
            username,
            user_id: userSub,
            offline_token: kc.refresh_token,
            expires_at: record.expires_at,
          },
          {
            headers: { 'Content-Type': 'application/json', 'X-Internal-Key': internalServiceKey() },
            timeout: 10000,
            validateStatus: () => true,
          }
        );
        if (resp.status < 200 || resp.status >= 300) {
          throw new Error(`orchestrator returned status ${resp.status}`);
        }
      } catch (err) {
        console.error('[P3DX_STEP_WARN] fl/vm-credentials: handoff failed:', {
          credential_id: record.credential_id,
          submissionId,
          error: err?.message || 'error',
        });
        await dropOfflineSession(sessionId, 'fl/vm-credentials');
        try {
          await store.setState(record.credential_id, 'expired', { reason: 'HANDOFF_FAILED' });
        } catch (storeErr) {
          console.error('[P3DX_STEP_WARN] fl/vm-credentials: could not mark record expired:', storeErr?.message || 'error');
        }
        return fail(res, 502, 'HANDOFF_FAILED', 'could not deliver the credential to the orchestrator');
      }

      console.log('[P3DX_STEP_OK] fl/vm-credentials: issued and handed off', {
        credential_id: record.credential_id,
        submissionId,
        username,
        fingerprint: record.token_fingerprint,
        expires_at: record.expires_at,
      });

      return res.json({ status: 'SUCCESS', credential_id: record.credential_id, expires_at: record.expires_at });
    } catch (err) {
      console.error('[P3DX_STEP_WARN] fl/vm-credentials: unexpected error:', err?.message || 'error');
      return fail(res, 500, 'INTERNAL_ERROR');
    }
  });

  // ------------------------------------------------------------------------
  // POST /fl/vm-token — VM sidecar exchanges its offline token for an access token
  // ------------------------------------------------------------------------
  router.post('/fl/vm-token', jsonBody, async (req, res) => {
    try {
      const credentialId = typeof req.body?.credential_id === 'string' ? req.body.credential_id.trim() : '';
      const offlineToken = typeof req.body?.offline_token === 'string' ? req.body.offline_token : '';
      if (!credentialId || !offlineToken || credentialId.length > 128) {
        return fail(res, 400, 'INVALID_REQUEST', 'credential_id and offline_token are required');
      }

      if (!rateLimiter(credentialId)) {
        return fail(res, 429, 'RATE_LIMITED');
      }

      let record;
      try {
        record = await store.get(credentialId);
      } catch (err) {
        console.error('[P3DX_STEP_WARN] fl/vm-token: record read failed:', err?.message || 'error');
        return fail(res, 503, 'CREDENTIAL_STORE_UNAVAILABLE');
      }
      if (!record) {
        return fail(res, 401, 'UNKNOWN_CREDENTIAL');
      }
      if (!fingerprintMatches(offlineToken, record.token_fingerprint)) {
        console.warn('[P3DX_STEP_WARN] fl/vm-token: fingerprint mismatch', { credential_id: credentialId });
        return fail(res, 401, 'INVALID_CREDENTIAL');
      }

      const expiresMs = Date.parse(record.expires_at);
      if (record.state === 'expired' || Number.isNaN(expiresMs) || now() >= expiresMs) {
        if (record.state !== 'expired') {
          await dropOfflineSession(record.session_id, 'fl/vm-token');
          try {
            await store.setState(credentialId, 'expired', { reason: 'CONTRACT_EXPIRED' });
          } catch (err) {
            console.error('[P3DX_STEP_WARN] fl/vm-token: could not mark record expired:', err?.message || 'error');
          }
        }
        return fail(res, 401, 'CREDENTIAL_EXPIRED');
      }

      let kc;
      try {
        kc = await keycloak.refreshVmToken(offlineToken);
      } catch (err) {
        console.warn('[P3DX_STEP_WARN] fl/vm-token: refresh failed:', { credential_id: credentialId, error: errSummary(err) });
        return fail(res, 401, 'REFRESH_FAILED');
      }

      const access = safeDecode(kc?.access_token);
      if (!access || !access.sid || access.sid !== record.session_id || access.azp !== vmClientId()) {
        console.warn('[P3DX_STEP_WARN] fl/vm-token: session mismatch', { credential_id: credentialId });
        return fail(res, 401, 'SESSION_MISMATCH');
      }

      let rotated;
      if (kc.refresh_token && kc.refresh_token !== offlineToken) {
        try {
          await store.updateFingerprint(credentialId, kc.refresh_token);
          rotated = kc.refresh_token;
        } catch (err) {
          // Don't hand out a token the record can't recognise; the old one
          // still works in Keycloak, so the VM simply retries.
          console.error('[P3DX_STEP_WARN] fl/vm-token: fingerprint update failed:', err?.message || 'error');
          return fail(res, 503, 'CREDENTIAL_STORE_UNAVAILABLE');
        }
      }

      console.log('[P3DX_STEP_OK] fl/vm-token: access token issued', {
        credential_id: credentialId,
        submissionId: record.submission_id,
        rotated: !!rotated,
      });

      return res.json({
        status: 'SUCCESS',
        access_token: kc.access_token,
        expires_in: kc.expires_in,
        ...(rotated ? { offline_token: rotated } : {}),
        contract_valid_until: record.expires_at,
      });
    } catch (err) {
      console.error('[P3DX_STEP_WARN] fl/vm-token: unexpected error:', err?.message || 'error');
      return fail(res, 500, 'INTERNAL_ERROR');
    }
  });

  // ------------------------------------------------------------------------
  // POST /internal/fl/vm-credentials/:id/delivered — orchestrator confirms delivery
  // ------------------------------------------------------------------------
  router.post('/internal/fl/vm-credentials/:id/delivered', authenticateOrchestrator, async (req, res) => {
    try {
      let record;
      try {
        record = await store.get(req.params.id);
      } catch (err) {
        console.error('[P3DX_STEP_WARN] fl/vm-credentials/delivered: record read failed:', err?.message || 'error');
        return fail(res, 503, 'CREDENTIAL_STORE_UNAVAILABLE');
      }
      if (!record) {
        return fail(res, 404, 'UNKNOWN_CREDENTIAL');
      }
      if (record.state === 'expired') {
        return fail(res, 409, 'CREDENTIAL_EXPIRED');
      }
      const updated = await store.setState(record.credential_id, 'delivered');
      console.log('[P3DX_STEP_OK] fl/vm-credentials: delivered', {
        credential_id: record.credential_id,
        submissionId: record.submission_id,
      });
      return res.json({ status: 'SUCCESS', credential_id: updated.credential_id, state: updated.state });
    } catch (err) {
      console.error('[P3DX_STEP_WARN] fl/vm-credentials/delivered: unexpected error:', err?.message || 'error');
      return fail(res, 503, 'CREDENTIAL_STORE_UNAVAILABLE');
    }
  });

  // Body-parser errors for the routes above (malformed JSON, too large). The
  // app-wide error middleware console.error()s the whole error object, whose
  // `body` property would be the raw request — i.e. the password/token.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (!isFlVmPath(req.path)) {
      return next(err);
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large' || err?.status === 400) {
      console.warn('[P3DX_STEP_WARN] fl/vm: rejected request body:', err.type || 'invalid body');
      return fail(res, err?.status === 413 ? 413 : 400, 'INVALID_REQUEST', 'malformed JSON body');
    }
    console.error('[P3DX_STEP_WARN] fl/vm: unexpected error:', err?.message || 'error');
    return fail(res, 500, 'INTERNAL_ERROR');
  });

  return router;
}

export default createFlVmRouter();
