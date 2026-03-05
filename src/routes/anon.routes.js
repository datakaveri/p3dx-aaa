import { Router } from 'express';
import {
  getAdminToken,
  createUser,
  getUserId,
  assignUserRole,
  loginUser,
} from '../services/keycloak.service.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { requireAnyRole, requireRole } from '../middlewares/role.middleware.js';
import { logAuditEvent, storeMaaTokens } from '../services/immudb.service.js';



const router = Router();

router.post('/register', async (req, res, next) => {
  const { username, email, password, firstName, lastName } = req.body;

  try {
    if (!username || !email || !password || !firstName || !lastName) {
      // Log failed registration attempt
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

    await createUser(
      { username, email, password, firstName, lastName },
      adminToken
    );

    const userId = await getUserId(username, adminToken);
    await assignUserRole(userId, adminToken);

    // Log successful registration with full details
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
      // Log duplicate registration attempt
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

    // Log registration error
    await logAuditEvent('USER_REGISTER_ERROR', username || 'unknown', {
      error: err.message,
      ip: req.ip,
      timestamp: new Date().toISOString(),
    });

    next(err);
  }
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

    // Log successful login with details
    await logAuditEvent('USER_LOGIN_SUCCESS', username, {
      ip: req.ip,
      userAgent: req.get('user-agent'),
      timestamp: new Date().toISOString(),
      tokenExpiresIn: tokenResponse.expires_in,
    });

    return res.json(payload);
  } catch (err) {
    // Log failed login attempt
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

router.get(
  '/me',
  verifyJWT,
  requireAnyRole(['user', 'admin']),
  async (req, res) => {
    // Log profile access
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
  }
);

router.post(
  '/maa-tokens',
  verifyJWT,
  requireRole('user'),
  async (req, res, next) => {
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
  }
);

export default router;
