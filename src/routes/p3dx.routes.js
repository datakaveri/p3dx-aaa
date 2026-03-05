import { Router } from 'express';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { requireAnyRole, requireRole } from '../middlewares/role.middleware.js';
import { getAdminToken, assignRealmRole } from '../services/keycloak.service.js';
import {
  createRoleRequest,
  listRoleRequests,
  listRoleRequestsForUser,
  getRoleRequestById,
  decideRoleRequest,
} from '../services/roleRequests.service.js';

const router = Router();

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
