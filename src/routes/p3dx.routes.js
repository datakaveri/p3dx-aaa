import { Router } from 'express';

// Mirrors InfraPolicyForm.jsx's slugify() exactly — used to derive an
// infra-provider's provider_id server-side from their verified JWT, so it
// can't be spoofed via the request body. Keep in sync if the frontend's
// version ever changes.
function slugify(s) {
  return String(s || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { requireAnyRole, requireRole } from '../middlewares/role.middleware.js';
import {
  getAdminToken,
  assignRealmRole,
  createUser,
  getUserId,
  assignUserRole,
  loginUser,
  refreshAccessToken,
} from '../services/keycloak.service.js';
import { getWorkloadContractById, logAuditEvent, storeMaaTokens, storeWorkloadContract } from '../services/immudb.service.js';
import {
  createRoleRequest,
  listRoleRequests,
  listRoleRequestsForUser,
  getRoleRequestById,
  decideRoleRequest,
} from '../services/roleRequests.service.js';
import {
  sendWorkloadToTop,
  generateContractFromGovLayer,
  startTeeSession,
  getTeeSessionStatus,
  downloadTeeSessionOutput,
  terminateTeeSession,
  sendParticipationNotifications,
  getRecipientNotifications,
  getSentNotifications,
  markParticipationNotificationRead,
  respondToParticipationNotification,
  buildSessionContract,
  getSessionContract,
} from '../services/top.service.js';
import { listProviderForms } from '../services/formSubmissions.service.js';
import {
  KEY_PAIR_ROLES,
  provisionDataProviderKeyPair,
  getPrivateKeyRecord,
  recordPrivateKeyDownload,
} from '../services/keyPair.service.js';

const router = Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function loadComposeUrlsConfig() {
  const configPath = path.resolve(__dirname, '..', 'config', 'compose-urls.json');
  const raw = await readFile(configPath, 'utf8');
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' ? parsed : null;
}

function requireTopApiKey(req, res, next) {
  const expectedRaw = process.env.TOP_BACKEND_API_KEY;
  const expected = typeof expectedRaw === 'string' ? expectedRaw.trim() : '';
  if (!expected) {
    return res.status(503).json({ status: 'FAILED', error: 'TOP_BACKEND_API_KEY_NOT_CONFIGURED' });
  }

  const provided = String(req.get('x-api-key') || '').trim();
  if (!provided || provided !== expected) {
    return res.status(403).json({ status: 'FAILED', error: 'FORBIDDEN' });
  }

  next();
}

function sendKnownError(res, err) {
  const msg = err?.message;

  if (msg === 'ROLE_NOT_ALLOWED') {
    return res.status(400).json({ status: 'FAILED', error: 'ROLE_NOT_ALLOWED' });
  }

  if (msg === 'ROLE_REQUEST_ALREADY_PENDING') {
    return res.status(409).json({ status: 'FAILED', error: 'ROLE_REQUEST_ALREADY_PENDING' });
  }

  if (msg === 'ROLE_ALREADY_GRANTED') {
    return res.status(409).json({ status: 'FAILED', error: 'ROLE_ALREADY_GRANTED' });
  }

  if (msg === 'ROLE_REQUEST_NOT_FOUND') {
    return res.status(404).json({ status: 'FAILED', error: 'ROLE_REQUEST_NOT_FOUND' });
  }

  if (msg === 'ROLE_REQUEST_NOT_PENDING') {
    return res.status(409).json({ status: 'FAILED', error: 'ROLE_REQUEST_NOT_PENDING' });
  }

  if (msg === 'INVALID_DECISION') {
    return res.status(400).json({ status: 'FAILED', error: 'INVALID_DECISION' });
  }

  if (msg === 'IMMUDB_NOT_INITIALIZED') {
    return res.status(503).json({ status: 'FAILED', error: 'IMMUDB_NOT_INITIALIZED' });
  }

  return null;
}

router.post('/register', async (req, res, next) => {
  const { username, email, password, firstName, lastName } = req.body;

  try {
    if (!username || !email || !password || !firstName || !lastName) {
      await logAuditEvent('USER_REGISTER_FAILED', username || 'unknown', {
        reason: 'MISSING_FIELDS',
        ip: req.ip,
        timestamp: new Date().toISOString(),
      });

      return res.status(400).json({
        status: 'FAILED',
        error: 'MISSING_FIELDS',
      });
    }

    const adminToken = await getAdminToken();

    await createUser({ username, email, password, firstName, lastName }, adminToken);

    const userId = await getUserId(username, adminToken);
    await assignUserRole(userId, adminToken);

    await logAuditEvent('USER_REGISTER_SUCCESS', username, {
      email,
      firstName,
      lastName,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });

    return res.status(201).json({
      status: 'SUCCESS',
      message: 'User registered successfully',
    });
  } catch (err) {
    if (err.response?.status === 409) {
      await logAuditEvent('USER_REGISTER_FAILED', username || 'unknown', {
        reason: 'USERNAME_ALREADY_EXISTS',
        ip: req.ip,
        timestamp: new Date().toISOString(),
      });

      return res.status(409).json({
        status: 'FAILED',
        error: 'USERNAME_ALREADY_EXISTS',
      });
    }

    await logAuditEvent('USER_REGISTER_ERROR', username || 'unknown', {
      error: err.message,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });

    next(err);
  }
});

router.get(
  '/workloads/contracts/:contractId/result',
  verifyJWT,
  requireRole('user'),
  async (req, res, next) => {
    try {
      const { contractId } = req.params;
      const record = await getWorkloadContractById(contractId);

      if (!record) {
        return res.status(404).json({ status: 'FAILED', error: 'CONTRACT_NOT_FOUND' });
      }

      const contract = record?.contract || record?.stored?.contract || record?.stored?.value?.contract;
      const contractObj = contract && typeof contract === 'object' ? contract : null;
      // Governance layer's unified contract schema nests application providers
      // under parties.application_providers[] rather than a singular
      // application_provider_terms object; app_name is the closest analog to
      // the old app_id (falls back to id when app_name isn't set).
      const appProvider = contractObj?.parties?.application_providers?.[0];
      const appId = appProvider?.app_name || appProvider?.id;

      const topBaseRaw = process.env.TOP_BASE_URL;
      const topBase = typeof topBaseRaw === 'string' ? topBaseRaw.trim().replace(/\/+$/, '') : '';
      if (!topBase) {
        return res.status(503).json({ status: 'FAILED', error: 'TOP_NOT_CONFIGURED' });
      }

      const url = `${topBase}/contracts/${contractId}`;
      const upstream = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      const text = await upstream.text();
      let data;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }

      if (!upstream.ok || data?.status !== 'SUCCESS') {
        return res.status(502).json({
          status: 'FAILED',
          error: 'TOP_SIGNED_CONTRACT_FETCH_FAILED',
          ...(process.env.NODE_ENV === 'production' ? {} : { detail: data || text }),
        });
      }

      return res.status(200).json({
        status: 'SUCCESS',
        tee_status: 'STARTED',
        contract_id: contractId,
        app_id: appId,
        signed_contract: data.contract,
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/login', (_req, res) => {
  res.redirect('/login');
});

router.post('/login', async (req, res, next) => {
  const { username, password } = req.body;

  try {
    const tokenResponse = await loginUser(username, password);

    const payload = {
      status: 'SUCCESS',
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      expires_in: tokenResponse.expires_in,
    };

    await logAuditEvent('USER_LOGIN_SUCCESS', username, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      timestamp: new Date().toISOString(),
      tokenExpiresIn: tokenResponse.expires_in,
    });

    return res.json(payload);
  } catch (err) {
    await logAuditEvent('USER_LOGIN_FAILED', username || 'unknown', {
      reason: 'INVALID_CREDENTIALS',
      ip: req.ip,
      userAgent: req.get('user-agent'),
      timestamp: new Date().toISOString(),
      error: err.message,
    });

    next(err);
  }
});

router.post('/refresh-token', async (req, res, next) => {
  const { refresh_token: refreshToken } = req.body;

  if (!refreshToken) {
    return res.status(400).json({ status: 'FAILED', error: 'MISSING_REFRESH_TOKEN' });
  }

  try {
    const tokenResponse = await refreshAccessToken(refreshToken);

    return res.json({
      status: 'SUCCESS',
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token,
      expires_in: tokenResponse.expires_in,
    });
  } catch (err) {
    return res.status(401).json({ status: 'FAILED', error: 'REFRESH_FAILED' });
  }
});

router.get('/me', verifyJWT, requireAnyRole(['user', 'admin']), async (req, res) => {
  await logAuditEvent('USER_PROFILE_ACCESS', req.user.preferred_username, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    timestamp: new Date().toISOString(),
    roles: req.user.realm_access?.roles,
  });

  res.json({
    status: 'SUCCESS',
    user: {
      username: req.user.preferred_username,
      email: req.user.email,
      roles: req.user.realm_access.roles,
    },
  });
});

router.post('/workloads/run', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const keycloakToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!keycloakToken) {
      return res.status(401).json({ status: 'FAILED', error: 'MISSING_AUTH_TOKEN' });
    }

    const datasetId = req.body?.datasetId || req.body?.dataset;
    const applicationId = req.body?.applicationId || req.body?.application;

    if (!datasetId || !applicationId) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_WORKLOAD_INPUT' });
    }

    console.log('[P3DX_STEP_OK] workload/run: request accepted', {
      datasetId,
      applicationId,
      user: req.user?.preferred_username || req.user?.sub,
    });

    // TOP now owns contract creation, consumer signing, policy check, orchestrator
    // signing, and TEE deployment. We send only the raw workload parameters.
    let topResult;
    try {
      topResult = await sendWorkloadToTop({ token: keycloakToken, datasetId, applicationId });

      console.log('[P3DX_STEP_OK] workload/run: workload sent to TOP', {
        sent: Boolean(topResult?.sent),
        skipped: Boolean(topResult?.skipped),
        status: topResult?.status,
        contractId: topResult?.data?.contract_id,
      });
    } catch (err) {
      topResult = { sent: false, skipped: false, error: err?.message || 'TOP_ERROR' };
    }

    const requiredRaw = process.env.TOP_REQUIRED;
    const topRequired = ['true', '1', 'yes'].includes(
      typeof requiredRaw === 'string' ? requiredRaw.trim().toLowerCase() : ''
    );

    if (topRequired && !topResult?.skipped && !topResult?.sent) {
      return res.status(502).json({ status: 'FAILED', error: 'TOP_SUBMISSION_FAILED', top: topResult });
    }

    // TOP returns the fully signed contract in the response body.
    // Store it in immuDB as a single audit record.
    const signedContract = topResult?.data?.contract ?? null;
    const contractId = topResult?.data?.contract_id ?? null;

    if (signedContract) {
      await storeWorkloadContract({
        contract: signedContract,
        datasetId,
        applicationId,
        user: req.user,
        metadata: {
          ip: req.ip,
          userAgent: req.get('user-agent'),
          top_signed: true,
          top_status: topResult?.status,
        },
      });

      console.log('[P3DX_STEP_OK] workload/run: signed contract stored (immudb)', { contractId });
    }

    return res.status(201).json({
      status: 'SUCCESS',
      contract: signedContract,
      contract_id: contractId,
      top: topResult,
    });
  } catch (err) {
    next(err);
  }
});

// Builds and returns a contract for display only — does NOT submit it anywhere.
// Generation happens in gov_layer itself (POST /generate-contract), which
// fetches the real policy (TEE/SMPC) or provider form (FL) from APD.
// Submission onward (POST /contract, signed) is deferred until the consumer
// signing model is decided.
router.post('/workloads/preview-contract', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const keycloakToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    if (!keycloakToken) {
      return res.status(401).json({ status: 'FAILED', error: 'MISSING_AUTH_TOKEN' });
    }

    const datasetId = req.body?.datasetId || req.body?.dataset;
    // datasetId is the real item_id (dataset picker now sends {id, name}
    // pairs — see formSubmissions.service.js's listDatasetNames). Fall back
    // to datasetId only for older/other callers that never sent a separate
    // name, so the gov_layer call still gets *something* human-readable.
    const datasetName = req.body?.datasetName || datasetId;
    const technique = req.body?.technique;
    const applicationId = req.body?.applicationId || req.body?.application || 'unselected-application';
    const infraId = req.body?.infraId || req.body?.infra_id;

    if (!datasetId) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_DATASET_ID' });
    }
    if (!['FL', 'TEE', 'SMPC'].includes(technique)) {
      return res.status(400).json({ status: 'FAILED', error: 'INVALID_TECHNIQUE' });
    }

    const contract = await generateContractFromGovLayer({
      token: keycloakToken,
      datasetId,
      datasetName,
      applicationId,
      technique,
      infraId,
    });

    console.log('[P3DX_STEP_OK] workloads/preview-contract: contract generated by gov_layer', {
      datasetId,
      technique,
      user: req.user?.preferred_username || req.user?.sub,
    });

    return res.status(200).json({ status: 'SUCCESS', contract });
  } catch (err) {
    next(err);
  }
});

// Starts a real TEE session — gov_layer's POST /v1/tee/sessions sequences
// provision -> attest -> run -> poll -> output against the actual
// confidential VM in the background and returns a sessionId immediately;
// poll /workloads/tee-sessions/:sessionId for progress. datasetUrl must be an
// https URL the CVM's managed identity can read.
router.post('/workloads/tee-sessions', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const { datasetUrl, datasetId, datasetName } = req.body || {};
    if (!datasetUrl || typeof datasetUrl !== 'string') {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_DATASET_URL' });
    }
    let parsed;
    try {
      parsed = new URL(datasetUrl);
    } catch {
      return res.status(400).json({ status: 'FAILED', error: 'INVALID_DATASET_URL' });
    }
    if (parsed.protocol !== 'https:') {
      return res.status(400).json({ status: 'FAILED', error: 'DATASET_URL_MUST_BE_HTTPS' });
    }

    const result = await startTeeSession({
      datasetUrl,
      datasetId,
      datasetName,
      consumerId: req.user?.preferred_username || req.user?.sub,
    });

    console.log('[P3DX_STEP_OK] workloads/tee-sessions: TEE session started', {
      sessionId: result?.sessionId,
      user: req.user?.preferred_username || req.user?.sub,
    });

    return res.status(202).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ status: 'FAILED', error: err.message });
    }
    next(err);
  }
});

// Polls the status of a TEE session started via /workloads/tee-sessions.
router.get('/workloads/tee-sessions/:sessionId', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const result = await getTeeSessionStatus({ sessionId: req.params.sessionId });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ status: 'FAILED', error: err.message });
    }
    next(err);
  }
});

// Downloads the anonymized output of a completed TEE session, streamed
// through from gov_layer as a file attachment.
router.get('/workloads/tee-sessions/:sessionId/output', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const { data, contentType, contentDisposition } = await downloadTeeSessionOutput({
      sessionId: req.params.sessionId,
    });

    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      contentDisposition || `attachment; filename="anonymized-${req.params.sessionId}.bin"`
    );
    return res.status(200).send(data);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ status: 'FAILED', error: err.message });
    }
    next(err);
  }
});

// Terminates a TEE session's confidential VM so it stops billing compute.
router.delete('/workloads/tee-sessions/:sessionId', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const result = await terminateTeeSession({ sessionId: req.params.sessionId });
    return res.status(200).json(result);
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ status: 'FAILED', error: err.message });
    }
    next(err);
  }
});

// TOP -> backend: verify that the access token TOP received matches the token used
// by the user when the workload contract was created.
router.post(
  '/workloads/contracts/:contractId/token-verify',
  requireTopApiKey,
  async (req, res, next) => {
    try {
      const { contractId } = req.params;
      const record = await getWorkloadContractById(contractId);

      if (!record) {
        return res.status(404).json({ status: 'FAILED', error: 'CONTRACT_NOT_FOUND' });
      }

      const expected =
        record?.metadata?.token_fingerprint ||
        record?.stored?.metadata?.token_fingerprint ||
        record?.stored?.metadata?.tokenFingerprint ||
        record?.token_fingerprint;

      if (!expected) {
        return res.status(409).json({ status: 'FAILED', error: 'TOKEN_FINGERPRINT_NOT_AVAILABLE' });
      }

      const provided = String(req.body?.token_fingerprint || req.body?.tokenFingerprint || '').trim();
      if (!provided) {
        return res.status(400).json({ status: 'FAILED', error: 'MISSING_TOKEN_FINGERPRINT' });
      }

      const match = provided === expected;

      if (match) {
        console.log('[P3DX_STEP_OK] token-verify: match', { contractId });
      }
      return res.status(200).json({ status: 'SUCCESS', match });
    } catch (err) {
      next(err);
    }
  }
);

// TOP -> backend: return docker compose URL for a given appId.
// This is used by TOP to trigger TEE deployment based on the contract app_id.
router.get('/apps/:appId/compose-url', requireTopApiKey, async (req, res, next) => {
  try {
    const appId = String(req.params?.appId || '').trim();
    if (!appId) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_APP_ID' });
    }

    const cfg = await loadComposeUrlsConfig();
    const composeUrls = cfg?.compose_urls;
    const url = composeUrls && typeof composeUrls === 'object' ? String(composeUrls[appId] || '').trim() : '';
    if (!url) {
      return res.status(404).json({ status: 'FAILED', error: 'COMPOSE_URL_NOT_FOUND' });
    }

    console.log('[P3DX_STEP_OK] compose-url: resolved', { appId });

    return res.status(200).json({ status: 'SUCCESS', app_id: appId, compose_url: url });
  } catch (err) {
    next(err);
  }
});

router.get('/workloads/contracts/:contractId', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const { contractId } = req.params;
    const record = await getWorkloadContractById(contractId);

    if (!record) {
      return res.status(404).json({ status: 'FAILED', error: 'CONTRACT_NOT_FOUND' });
    }

    return res.status(200).json({ status: 'SUCCESS', record });
  } catch (err) {
    next(err);
  }
});

router.post('/maa-tokens', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const keycloakToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;

    if (!keycloakToken) {
      return res.status(401).json({
        status: 'FAILED',
        error: 'MISSING_AUTH_TOKEN',
      });
    }

    const contentType = (req.headers['content-type'] || '').toLowerCase();
    let maaTokens = [];

    if (contentType.includes('application/json')) {
      let jsonBody = req.body;

      if (typeof jsonBody === 'string') {
        const trimmed = jsonBody.trim();
        if (trimmed) {
          try {
            jsonBody = JSON.parse(trimmed);
          } catch {
            jsonBody = req.body;
          }
        }
      }

      if (Array.isArray(jsonBody?.jwts)) {
        maaTokens = jsonBody.jwts;
      } else if (typeof jsonBody?.jwts === 'string') {
        maaTokens = [jsonBody.jwts];
      } else if (Array.isArray(jsonBody?.maa_tokens)) {
        maaTokens = jsonBody.maa_tokens;
      } else if (typeof jsonBody?.maa_token === 'string') {
        maaTokens = [jsonBody.maa_token];
      } else if (typeof jsonBody?.tokens === 'string') {
        maaTokens = [jsonBody.tokens];
      }
    } else {
      const raw = typeof req.body === 'string' ? req.body : '';
      const trimmed = raw.trim();
      if (trimmed) {
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
              maaTokens = parsed;
            }
          } catch {
            maaTokens = [];
          }
        }

        if (maaTokens.length === 0) {
          maaTokens = trimmed.split(/[\n,\s]+/).filter(Boolean);
        }
      }
    }

    if (!Array.isArray(maaTokens) || maaTokens.length === 0) {
      await logAuditEvent('MAA_TOKENS_STORE_FAILED', req.user.sub, {
        reason: 'MISSING_MAA_TOKENS',
        ip: req.ip,
        userAgent: req.get('user-agent'),
        timestamp: new Date().toISOString(),
      });

      return res.status(400).json({
        status: 'FAILED',
        error: 'MISSING_MAA_TOKENS',
      });
    }

    const stored = await storeMaaTokens({
      keycloakToken,
      userId: req.user.sub,
      maaTokens,
      metadata: {
        ip: req.ip,
        userAgent: req.get('user-agent'),
        timestamp: new Date().toISOString(),
        preferredUsername: req.user.preferred_username,
      },
    });

    const storedCount = Array.isArray(stored?.stored) ? stored.stored.length : 0;

    await logAuditEvent('MAA_TOKENS_STORED', req.user.sub, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      timestamp: new Date().toISOString(),
      maaTokenCount: maaTokens.length,
      storedCount,
      storageErrorsCount: Array.isArray(stored?.errors) ? stored.errors.length : 0,
    });

    return res.json({
      status: 'SUCCESS',
      stored: storedCount,
      errors: Array.isArray(stored?.errors) ? stored.errors : [],
    });
  } catch (err) {
    await logAuditEvent('MAA_TOKENS_STORE_ERROR', req.user?.sub || 'unknown', {
      error: err.message,
      ip: req.ip,
      userAgent: req.get('user-agent'),
      timestamp: new Date().toISOString(),
    });
    next(err);
  }
});

router.post('/policy', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const roles = req.user?.realm_access?.roles || [];
    // Infrastructure policies (rules.policy_type === 'infra-provider', set by
    // InfraPolicyForm.jsx) require the infra-provider role and nothing else —
    // this is the actual enforcement of "infra-provider may only set policy
    // for SMPC infrastructure, never a Spider/FL/TEE dataset-access policy".
    // Dataset policies (rules.policy_type === 'data-provider', set by
    // PolicyForm.jsx) get the same server-side provider_id derivation, for
    // the same reason — it's what makes "My Datasets" ownership-scoped
    // list/edit/delete trustworthy instead of client-spoofable. Any other
    // (untagged) policy shape keeps the original data-provider-only gate,
    // with no provider_id override, for backward compatibility.
    const policyType = req.body?.rules?.policy_type;
    if (policyType === 'infra-provider' || policyType === 'data-provider') {
      const requiredRole = policyType === 'infra-provider' ? 'infra-provider' : 'data-provider';
      if (!roles.includes(requiredRole)) {
        return res.status(403).json({ status: 'FAILED', error: 'INSUFFICIENT_ROLE' });
      }
      // Never trust the client-supplied provider_id — derive it server-side
      // from the caller's verified JWT instead. This is what makes APD's
      // write-path ownership check (item_id vs. existing provider_id) a real
      // guarantee rather than a comparison of two client-supplied strings.
      req.body = {
        ...req.body,
        provider_id: `provider-${slugify(req.user?.preferred_username || req.user?.email)}`,
      };
    } else if (!roles.includes('data-provider')) {
      return res.status(403).json({ status: 'FAILED', error: 'INSUFFICIENT_ROLE' });
    }

    const apdBaseUrlRaw = process.env.APD_BASE_URL;
    const apdBaseUrl = typeof apdBaseUrlRaw === 'string' ? apdBaseUrlRaw.trim() : '';
    if (!apdBaseUrl) {
      return res.status(503).json({ status: 'FAILED', error: 'APD_NOT_CONFIGURED' });
    }

    const url = apdBaseUrl.endsWith('/')
      ? `${apdBaseUrl}api/v1/policy`
      : `${apdBaseUrl}/api/v1/policy`;

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(req.body || {}),
    });

    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'FAILED',
        error: data?.message || data?.error || 'APD_POLICY_SUBMIT_FAILED',
        ...(process.env.NODE_ENV === 'production' ? {} : { detail: data || text }),
      });
    }

    console.log('[P3DX_STEP_OK] policy: submitted to APD', {
      policyId: data?.policyId,
      itemId: data?.itemId,
    });

    return res.status(201).json({ status: 'SUCCESS', apd: data });
  } catch (err) {
    next(err);
  }
});

// GET /policy/mine — "My Infrastructure" dashboard list for the logged-in
// infra-provider. provider_id is derived from the JWT the same way POST
// /policy now does, then forwarded to APD as a query param.
router.get('/policy/mine', verifyJWT, requireRole('infra-provider'), async (req, res, next) => {
  try {
    const providerId = `provider-${slugify(req.user?.preferred_username || req.user?.email)}`;

    const apdBaseUrlRaw = process.env.APD_BASE_URL;
    const apdBaseUrl = typeof apdBaseUrlRaw === 'string' ? apdBaseUrlRaw.trim() : '';
    if (!apdBaseUrl) {
      return res.status(503).json({ status: 'FAILED', error: 'APD_NOT_CONFIGURED' });
    }

    const base = apdBaseUrl.endsWith('/') ? apdBaseUrl.slice(0, -1) : apdBaseUrl;
    const url = `${base}/api/v1/policy/mine?provider_id=${encodeURIComponent(providerId)}`;

    const upstream = await fetch(url);
    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'FAILED',
        error: data?.message || data?.error || 'APD_POLICY_LIST_FAILED',
      });
    }

    return res.json({ status: 'SUCCESS', data: data?.data || [] });
  } catch (err) {
    next(err);
  }
});

// DELETE /policy/by-item/:itemId — soft-deletes one of the logged-in
// infra-provider's own infrastructure entries. provider_id is derived from
// the JWT (never trusted from the client), so APD's ownership-scoped delete
// query can only ever match the caller's own entries.
router.delete('/policy/by-item/:itemId', verifyJWT, requireRole('infra-provider'), async (req, res, next) => {
  try {
    const providerId = `provider-${slugify(req.user?.preferred_username || req.user?.email)}`;

    const apdBaseUrlRaw = process.env.APD_BASE_URL;
    const apdBaseUrl = typeof apdBaseUrlRaw === 'string' ? apdBaseUrlRaw.trim() : '';
    if (!apdBaseUrl) {
      return res.status(503).json({ status: 'FAILED', error: 'APD_NOT_CONFIGURED' });
    }

    const base = apdBaseUrl.endsWith('/') ? apdBaseUrl.slice(0, -1) : apdBaseUrl;
    const url = `${base}/api/v1/policy/by-item/${encodeURIComponent(req.params.itemId)}?provider_id=${encodeURIComponent(providerId)}`;

    const upstream = await fetch(url, { method: 'DELETE' });
    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (upstream.status === 404) {
      return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND' });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'FAILED',
        error: data?.message || data?.error || 'APD_POLICY_DELETE_FAILED',
      });
    }

    return res.json({ status: 'SUCCESS' });
  } catch (err) {
    next(err);
  }
});

// GET /policy/mine-datasets — "My Datasets" dashboard list for the logged-in
// data-provider. Mirrors GET /policy/mine exactly.
router.get('/policy/mine-datasets', verifyJWT, requireRole('data-provider'), async (req, res, next) => {
  try {
    const providerId = `provider-${slugify(req.user?.preferred_username || req.user?.email)}`;

    const apdBaseUrlRaw = process.env.APD_BASE_URL;
    const apdBaseUrl = typeof apdBaseUrlRaw === 'string' ? apdBaseUrlRaw.trim() : '';
    if (!apdBaseUrl) {
      return res.status(503).json({ status: 'FAILED', error: 'APD_NOT_CONFIGURED' });
    }

    const base = apdBaseUrl.endsWith('/') ? apdBaseUrl.slice(0, -1) : apdBaseUrl;
    const url = `${base}/api/v1/policy/mine-datasets?provider_id=${encodeURIComponent(providerId)}`;

    const upstream = await fetch(url);
    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'FAILED',
        error: data?.message || data?.error || 'APD_POLICY_LIST_FAILED',
      });
    }

    return res.json({ status: 'SUCCESS', data: data?.data || [] });
  } catch (err) {
    next(err);
  }
});

// GET /policy/mine-datasets/:itemId — full detail for one of the logged-in
// data-provider's own dataset entries, for PolicyForm.jsx's Edit flow. Calls
// APD's generic (unfiltered) by-item lookup directly — not the public
// InfraCat-style stripped endpoint — then enforces ownership here before
// returning anything, and strips provider_id/provider_email/issuedBy/
// policyId from the response (those stay derived from the logged-in user on
// the frontend, never round-tripped from fetched data).
router.get('/policy/mine-datasets/:itemId', verifyJWT, requireRole('data-provider'), async (req, res, next) => {
  try {
    const providerId = `provider-${slugify(req.user?.preferred_username || req.user?.email)}`;

    const apdBaseUrlRaw = process.env.APD_BASE_URL;
    const apdBaseUrl = typeof apdBaseUrlRaw === 'string' ? apdBaseUrlRaw.trim() : '';
    if (!apdBaseUrl) {
      return res.status(503).json({ status: 'FAILED', error: 'APD_NOT_CONFIGURED' });
    }

    const base = apdBaseUrl.endsWith('/') ? apdBaseUrl.slice(0, -1) : apdBaseUrl;
    const url = `${base}/api/v1/policy/by-item/${encodeURIComponent(req.params.itemId)}`;

    const upstream = await fetch(url);
    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (upstream.status === 404) {
      return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND' });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'FAILED',
        error: data?.message || data?.error || 'APD_POLICY_FETCH_FAILED',
      });
    }

    const policy = data?.data;
    if (!policy || policy.provider_id !== providerId) {
      return res.status(policy ? 403 : 404).json({ status: 'FAILED', error: policy ? 'FORBIDDEN' : 'NOT_FOUND' });
    }

    return res.json({
      status: 'SUCCESS',
      data: {
        item_id: policy.itemId,
        rules: policy.rules,
        is_private: policy.is_private,
        data_url: policy.data_url,
        expiresAt: policy.expiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /policy/by-item-dataset/:itemId — soft-deletes one of the logged-in
// data-provider's own dataset entries. Mirrors DELETE /policy/by-item/:itemId
// exactly.
router.delete('/policy/by-item-dataset/:itemId', verifyJWT, requireRole('data-provider'), async (req, res, next) => {
  try {
    const providerId = `provider-${slugify(req.user?.preferred_username || req.user?.email)}`;

    const apdBaseUrlRaw = process.env.APD_BASE_URL;
    const apdBaseUrl = typeof apdBaseUrlRaw === 'string' ? apdBaseUrlRaw.trim() : '';
    if (!apdBaseUrl) {
      return res.status(503).json({ status: 'FAILED', error: 'APD_NOT_CONFIGURED' });
    }

    const base = apdBaseUrl.endsWith('/') ? apdBaseUrl.slice(0, -1) : apdBaseUrl;
    const url = `${base}/api/v1/policy/by-item-dataset/${encodeURIComponent(req.params.itemId)}?provider_id=${encodeURIComponent(providerId)}`;

    const upstream = await fetch(url, { method: 'DELETE' });
    const text = await upstream.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }

    if (upstream.status === 404) {
      return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND' });
    }
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'FAILED',
        error: data?.message || data?.error || 'APD_POLICY_DELETE_FAILED',
      });
    }

    return res.json({ status: 'SUCCESS' });
  } catch (err) {
    next(err);
  }
});

router.post('/role-requests', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const roleName = req.body?.role || req.body?.role_name;
    if (!roleName || typeof roleName !== 'string') {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_ROLE' });
    }

    const roles = req.user?.realm_access?.roles || [];
    if (roles.includes(roleName)) {
      return res.status(409).json({ status: 'FAILED', error: 'ROLE_ALREADY_GRANTED' });
    }

    // Every role — including output-owner, which used to auto-approve —
    // now waits on an admin decision via POST /admin/role-requests/:id/decision.
    const created = await createRoleRequest({
      userId: req.user.sub,
      roleName,
      requestedBy: req.user.preferred_username || req.user.sub,
    });

    return res.status(201).json({ status: 'SUCCESS', request: created });
  } catch (err) {
    const handled = sendKnownError(res, err);
    if (handled) {
      return;
    }
    next(err);
  }
});

router.get('/role-requests/my', verifyJWT, requireAnyRole(['user', 'admin']), async (req, res, next) => {
  try {
    const requests = await listRoleRequestsForUser({ userId: req.user.sub });
    return res.json({ status: 'SUCCESS', requests });
  } catch (err) {
    const handled = sendKnownError(res, err);
    if (handled) {
      return;
    }
    next(err);
  }
});

router.get('/admin/role-requests', verifyJWT, requireRole('admin'), async (req, res, next) => {
  try {
    const status = req.query?.status;
    const requests = await listRoleRequests({ status });
    return res.json({ status: 'SUCCESS', requests });
  } catch (err) {
    const handled = sendKnownError(res, err);
    if (handled) {
      return;
    }
    next(err);
  }
});

router.post(
  '/admin/role-requests/:id/decision',
  verifyJWT,
  requireRole('admin'),
  async (req, res, next) => {
    try {
      const requestId = req.params.id;
      const decision = req.body?.decision;

      if (!decision) {
        return res.status(400).json({ status: 'FAILED', error: 'MISSING_DECISION' });
      }

      const current = await getRoleRequestById({ requestId });
      if (!current) {
        return res.status(404).json({ status: 'FAILED', error: 'ROLE_REQUEST_NOT_FOUND' });
      }

      const updated = await decideRoleRequest({
        requestId,
        decision,
        decidedBy: req.user.preferred_username || req.user.sub,
      });

      if (String(decision).toUpperCase() === 'APPROVE') {
        const adminToken = await getAdminToken();
        await assignRealmRole(updated.user_id, updated.role_name, adminToken);

        if (KEY_PAIR_ROLES.has(updated.role_name)) {
          try {
            await provisionDataProviderKeyPair({ userId: updated.user_id, roleName: updated.role_name });
          } catch (err) {
            console.error('[keypair] Failed to provision data-provider key pair:', err.message);
          }
        }
      }

      return res.json({ status: 'SUCCESS', request: updated });
    } catch (err) {
      const handled = sendKnownError(res, err);
      if (handled) {
        return;
      }
      next(err);
    }
  }
);

// Whether a data-provider key pair exists for the caller. One key pair is
// shared across both data-provider roles, so the lookup is per-user — the
// :roleName segment is kept in the URL only to gate on the caller actually
// holding that role. Lets the UI decide whether to show the "Download
// Private Key" button.
router.get('/keys/:roleName/status', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const roleName = req.params.roleName;
    if (!KEY_PAIR_ROLES.has(roleName)) {
      return res.status(400).json({ status: 'FAILED', error: 'ROLE_NOT_ALLOWED' });
    }

    const record = await getPrivateKeyRecord({ userId: req.user.sub });
    return res.json({
      status: 'SUCCESS',
      exists: Boolean(record),
      download_count: record?.download_count || 0,
    });
  } catch (err) {
    next(err);
  }
});

// Private key download. The key is streamed straight to the response as a
// file attachment (never returned as JSON, never rendered) and stays
// available for repeat downloads — the user may lose the file, switch
// machines, etc. Each download is still audit-logged. The same private key
// is served regardless of which KEY_PAIR_ROLES role's URL is used, since
// every such role shares one key pair for a given user.
router.get('/keys/:roleName/private-key', verifyJWT, requireRole('user'), async (req, res, next) => {
  try {
    const roleName = req.params.roleName;
    if (!KEY_PAIR_ROLES.has(roleName)) {
      return res.status(400).json({ status: 'FAILED', error: 'ROLE_NOT_ALLOWED' });
    }

    const roles = req.user?.realm_access?.roles || [];
    if (!roles.includes(roleName)) {
      return res.status(403).json({ status: 'FAILED', error: 'INSUFFICIENT_ROLE' });
    }

    const record = await getPrivateKeyRecord({ userId: req.user.sub });
    if (!record || !record.private_key_pem) {
      return res.status(404).json({ status: 'FAILED', error: 'KEY_NOT_FOUND' });
    }

    await recordPrivateKeyDownload({ userId: req.user.sub });

    await logAuditEvent('DATA_PROVIDER_PRIVATE_KEY_DOWNLOADED', req.user.sub, {
      roleName,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });

    res.setHeader('Content-Type', 'application/x-pem-file');
    res.setHeader('Content-Disposition', `attachment; filename="${roleName}-private-key.pem"`);
    return res.status(200).send(record.private_key_pem);
  } catch (err) {
    next(err);
  }
});

// Participation-consent notifications — proxied through to gov_layer's
// fl_notifications.go (POST /notifications etc.), which itself takes no auth
// token, so verifyJWT here is the only gate. Usernames for the recipient's
// own actions (read/respond) are always taken from the verified token, never
// from the request body, so a provider can't act as someone else.

// POST /notify-providers — output owner sends (or re-sends) a participation
// message to every requested data provider (today: the whole directory,
// broadcast regardless of the owner's manual pick). The payload separately
// carries the owner's manually-checked roster (selected_providers, may be a
// smaller subset or empty) plus whichever recipients have already responded
// "willing" (accepted so far), so providers always see live status alongside
// their accept/decline prompt (see FederatedLearningDashboard.jsx's isRequest
// rendering). Accepting also signs that provider's party on the session's
// contract (p3dx_gov_layer db.SignDataProviderParty).
router.post('/notify-providers', verifyJWT, async (req, res, next) => {
  try {
    const { selected_providers, requested_providers, willing_providers, output_owner_id, submission_id } = req.body || {};
    const requestedRoster = Array.isArray(requested_providers) && requested_providers.length
      ? requested_providers
      : selected_providers;
    if (!Array.isArray(requestedRoster) || requestedRoster.length === 0) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_REQUESTED_PROVIDERS' });
    }

    const senderUsername = req.user?.preferred_username || output_owner_id;
    const recipients = requestedRoster
      .filter(p => p && p.id && p.username)
      .map(p => ({ id: p.id, username: p.username }));
    if (recipients.length === 0) {
      return res.status(400).json({ status: 'FAILED', error: 'REQUESTED_PROVIDERS_MISSING_ID_OR_USERNAME' });
    }

    const selectedRoster = Array.isArray(selected_providers) ? selected_providers : [];
    const willingCount = Array.isArray(willing_providers) ? willing_providers.length : 0;
    const message = `${senderUsername} requested ${requestedRoster.length} data provider(s)` +
      (submission_id ? ` for session ${submission_id}` : ' for a federated learning session') +
      (selectedRoster.length ? ` — ${selectedRoster.length} selected by the owner` : '') +
      ` — ${willingCount} confirmed willing so far.`;

    const result = await sendParticipationNotifications({
      recipients,
      senderUsername,
      message,
      payload: {
        kind: 'participation_request',
        submission_id,
        output_owner_id: output_owner_id || senderUsername,
        selected_providers: selectedRoster,
        requested_providers: requestedRoster,
        willing_providers: Array.isArray(willing_providers) ? willing_providers : [],
      },
    });

    console.log('[P3DX_STEP_OK] notify-providers: sent', {
      sender: senderUsername, recipients: recipients.length, submission_id,
    });
    return res.status(201).json({ status: 'SUCCESS', created: result?.created ?? recipients.length });
  } catch (err) {
    next(err);
  }
});

// POST /notify-roster — output owner sends the FINAL participant roster, once
// every invited data provider has weighed in. Recipients are the providers who
// actually confirmed willing (willing_providers) — this is a done-deal
// announcement, not another accept/decline prompt. selected_providers is kept
// for context (the owner's original pick) so the message/payload can show
// "N of M selected are participating." This is also the point where the
// session's FINAL contract gets built (finalize=true): each willing provider's
// dataset_name/dataset_location_url is pulled from their most recent APD
// provider-form (keyed by data_owner_id == username, same lookup GET
// /api/v1/data-providers uses for RAM) so the contract's data-provider
// entries carry real dataset info instead of being left blank.
router.post('/notify-roster', verifyJWT, async (req, res, next) => {
  try {
    const { selected_providers, willing_providers, output_owner_id, submission_id } = req.body || {};
    const willingRoster = Array.isArray(willing_providers) ? willing_providers : [];
    if (willingRoster.length === 0) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_WILLING_PROVIDERS' });
    }

    const senderUsername = req.user?.preferred_username || output_owner_id;
    const recipients = willingRoster
      .filter(p => p && p.id && p.username)
      .map(p => ({ id: p.id, username: p.username }));
    if (recipients.length === 0) {
      return res.status(400).json({ status: 'FAILED', error: 'WILLING_PROVIDERS_MISSING_ID_OR_USERNAME' });
    }

    const selectedRoster = Array.isArray(selected_providers) ? selected_providers : [];
    const names = recipients.map(p => p.username).join(', ');
    const message = `${senderUsername} confirmed the final roster` +
      (submission_id ? ` for session ${submission_id}` : ' for this federated learning session') +
      ` — participating: ${names}.`;

    const result = await sendParticipationNotifications({
      recipients,
      senderUsername,
      message,
      payload: {
        kind: 'final_roster',
        submission_id,
        output_owner_id: output_owner_id || senderUsername,
        selected_providers: selectedRoster,
        willing_providers: willingRoster,
      },
    });

    console.log('[P3DX_STEP_OK] notify-roster: sent', {
      sender: senderUsername, recipients: recipients.length, submission_id,
    });

    let contractResult = null;
    let contractError = null;
    if (submission_id) {
      try {
        const providerForms = await listProviderForms();
        const formByOwner = new Map();
        for (const form of providerForms) {
          const owner = form.data_owner_id;
          if (owner && !formByOwner.has(owner)) formByOwner.set(owner, form);
        }
        const parties = recipients.map(p => {
          const form = formByOwner.get(p.username);
          return {
            id: p.id,
            username: p.username,
            dataset_name: form?.dataset_name || '',
            data_url: form?.dataset_location_url || '',
          };
        });
        contractResult = await buildSessionContract({
          submissionId: submission_id,
          outputOwnerUserId: output_owner_id || senderUsername,
          parties,
          finalize: true,
        });
        console.log('[P3DX_STEP_OK] notify-roster: contract finalized', {
          submission_id, contract_id: contractResult?.contract_id,
        });
      } catch (err) {
        contractError = err.message || 'Failed to build session contract';
        console.warn('[P3DX_STEP_WARN] notify-roster: contract build failed:', contractError);
      }
    }

    return res.status(201).json({
      status: 'SUCCESS',
      created: result?.created ?? recipients.length,
      contract_id: contractResult?.contract_id,
      contract: contractResult?.contract,
      contract_error: contractError,
    });
  } catch (err) {
    next(err);
  }
});

// GET /contract/:sessionId — read back the stored FL session contract (draft
// before Final Roster, finalized after) so the owner can view/inspect it.
router.get('/contract/:sessionId', verifyJWT, async (req, res, next) => {
  try {
    const contract = await getSessionContract({ sessionId: req.params.sessionId });
    if (!contract) {
      return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND', message: 'No contract for this session' });
    }
    return res.json(contract);
  } catch (err) {
    next(err);
  }
});

// GET /notification-responses — output owner reads back the participation
// responses (accepted/declined) for notifications they've sent, so the
// frontend can compute the "willing" subset before the next Send Message.
router.get('/notification-responses', verifyJWT, async (req, res, next) => {
  try {
    const senderUsername = req.user?.preferred_username;
    if (!senderUsername) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_USERNAME' });
    }
    const notifications = await getSentNotifications({ senderUsername });
    return res.json({ status: 'SUCCESS', notifications });
  } catch (err) {
    next(err);
  }
});

// GET /my-notifications — a data provider's own participation notifications.
router.get('/my-notifications', verifyJWT, async (req, res, next) => {
  try {
    const username = req.user?.preferred_username;
    if (!username) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_USERNAME' });
    }
    const notifications = await getRecipientNotifications({ username });
    const unread_count = notifications.filter(n => !n.read).length;
    return res.json({ status: 'SUCCESS', notifications, unread_count });
  } catch (err) {
    next(err);
  }
});

// GET /notifications/stream — Server-Sent Events push for a data provider's
// notifications. EventSource can't set an Authorization header, so (like
// gov_layer's own notification endpoints) this route takes no JWT, only the
// username to watch; it never returns notification content itself, just a
// nudge to refetch via the authenticated /my-notifications above. Bridges the
// gap since gov_layer is REST-only: polls it on the sender's behalf and
// forwards a push event the moment a new notification shows up.
router.get('/notifications/stream', async (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!username) {
    return res.status(400).json({ status: 'FAILED', error: 'MISSING_USERNAME' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  // Seeded on the first poll so pre-existing notifications don't fire an
  // event on connect — only ones created after this stream opened should.
  let knownIds = null;

  const poll = async () => {
    try {
      const notifications = await getRecipientNotifications({ username });
      const currentIds = new Set(notifications.map(n => n.id));
      if (knownIds === null) {
        knownIds = currentIds;
        return;
      }
      const hasNew = notifications.some(n => !knownIds.has(n.id));
      knownIds = currentIds;
      if (hasNew) {
        res.write(`data: ${JSON.stringify({ type: 'notification' })}\n\n`);
      }
    } catch (err) {
      console.warn('[SSE] notifications poll failed:', err.message);
    }
  };

  poll();
  const pollInterval = setInterval(poll, 4000);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);

  req.on('close', () => {
    clearInterval(pollInterval);
    clearInterval(heartbeat);
    res.end();
  });
});

// POST /notifications/:id/read — mark one of the caller's own notifications read.
router.post('/notifications/:id/read', verifyJWT, async (req, res, next) => {
  try {
    const username = req.user?.preferred_username;
    if (!username) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_USERNAME' });
    }
    const result = await markParticipationNotificationRead({ notificationId: req.params.id, username });
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /notifications/:id/respond — a data provider accepts/declines their
// participation request. Accepting signs that provider's contract party.
router.post('/notifications/:id/respond', verifyJWT, async (req, res, next) => {
  try {
    const username = req.user?.preferred_username;
    if (!username) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_USERNAME' });
    }
    const { response, message } = req.body || {};
    if (response !== 'accepted' && response !== 'declined') {
      return res.status(400).json({ status: 'FAILED', error: 'INVALID_RESPONSE' });
    }
    const result = await respondToParticipationNotification({
      notificationId: req.params.id, username, response, message: message || '',
    });
    console.log('[P3DX_STEP_OK] notifications/respond:', { username, response, id: req.params.id });
    return res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
