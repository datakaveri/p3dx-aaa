import { Router } from 'express';
import {
  getAdminToken,
  createUser,
  getUserId,
  assignUserRole,
  loginUser,
} from '../services/keycloak.service.js';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/role.middleware.js';
import { logAuditEvent } from '../services/immudb.service.js';



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
  requireRole('user'),
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

export default router;
