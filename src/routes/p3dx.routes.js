import { Router } from 'express';
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
} from '../services/keycloak.service.js';
import { getWorkloadContractById, logAuditEvent, storeMaaTokens, storeWorkloadContract } from '../services/immudb.service.js';
import {
  createRoleRequest,
  listRoleRequests,
  listRoleRequestsForUser,
  getRoleRequestById,
  decideRoleRequest,
} from '../services/roleRequests.service.js';
import { sendWorkloadToTop } from '../services/top.service.js';

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
      const appId = contractObj?.application_provider_terms?.app_id;

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
    if (!roles.includes('data-provider')) {
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

export default router;
