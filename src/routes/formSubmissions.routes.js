import { Router } from 'express';
import { verifyJWT } from '../middlewares/auth.middleware.js';
import { requireRole } from '../middlewares/role.middleware.js';
import {
  createOutputOwnerSubmission,
  createDataProviderForm,
  listSubmissions,
  getSubmission,
  deleteSubmission,
  listDatasetNames,
  listProviderForms,
} from '../services/formSubmissions.service.js';
import { getAdminToken, getUsersByRole } from '../services/keycloak.service.js';

// Public-facing form endpoints, called directly by the frontend. Form
// creation, storage, and CRUD (id minting, coercion logic) all live here now.
// Each write also pushes the document to the governance layer (see
// govLayerPush.service.js) so FL orchestration/reports have a copy.
const router = Router();

function sendStoreError(res, err) {
  if (err?.name === 'APDNotConfiguredError') {
    return res.status(503).json({ status: 'FAILED', error: 'APD_NOT_CONFIGURED' });
  }
  if (err?.name === 'APDRequestError') {
    return res.status(err.status || 502).json({
      status: 'FAILED', error: 'APD_REQUEST_FAILED', message: err.message,
    });
  }
  return null;
}

router.post('/form-submissions', verifyJWT, async (req, res, next) => {
  try {
    const payload = req.body?.payload;
    if (!payload) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_PAYLOAD' });
    }
    const missing = ['form_id', 'requested_by', 'output_owner_id'].filter(k => !payload[k]);
    if (missing.length > 0) {
      return res.status(400).json({
        status: 'FAILED', error: 'MISSING_REQUIRED_FIELDS',
        message: `Missing required fields: ${missing.join(', ')}`,
      });
    }

    const submissionId = await createOutputOwnerSubmission(payload);
    return res.status(201).json({
      status: 'SUCCESS', message: 'Form submission stored successfully',
      submission_id: submissionId,
    });
  } catch (err) {
    if (sendStoreError(res, err)) return;
    next(err);
  }
});

router.get('/form-submissions', verifyJWT, async (req, res, next) => {
  try {
    const submissions = await listSubmissions();
    return res.json({ status: 'SUCCESS', count: submissions.length, submissions });
  } catch (err) {
    if (sendStoreError(res, err)) return;
    next(err);
  }
});

router.get('/form-submissions/:id', verifyJWT, async (req, res, next) => {
  try {
    const submission = await getSubmission(req.params.id);
    if (!submission) {
      return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND', message: 'Form submission not found' });
    }
    return res.json({ status: 'SUCCESS', submission });
  } catch (err) {
    if (sendStoreError(res, err)) return;
    next(err);
  }
});

router.delete('/form-submissions/:id', verifyJWT, async (req, res, next) => {
  try {
    const deleted = await deleteSubmission(req.params.id);
    if (!deleted) {
      return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND', message: 'Form submission not found' });
    }
    return res.json({ status: 'SUCCESS', message: 'Form submission deleted successfully' });
  } catch (err) {
    if (sendStoreError(res, err)) return;
    next(err);
  }
});

router.get('/available-datasets', verifyJWT, async (req, res, next) => {
  try {
    const datasets = await listDatasetNames();
    return res.json({ status: 'SUCCESS', datasets });
  } catch (err) {
    if (sendStoreError(res, err)) return;
    next(err);
  }
});

// The real data-provider directory: every Keycloak user holding the
// data-provider role, enriched with their most-recently-submitted RAM usage
// (from APD's provider forms, keyed by data_owner_id == username). Used by
// the output-owner's provider-selection step in the FL flow.
router.get('/api/v1/data-providers', verifyJWT, async (req, res, next) => {
  try {
    const [adminToken, providerForms] = await Promise.all([
      getAdminToken(),
      listProviderForms(),
    ]);
    const users = await getUsersByRole('data-provider', adminToken);

    // listProviderForms() is most-recent-first, so the first form seen per
    // owner is their latest submission.
    const ramByOwner = new Map();
    for (const form of providerForms) {
      const owner = form.data_owner_id;
      if (owner && !ramByOwner.has(owner)) {
        ramByOwner.set(owner, form.ram_usage ?? null);
      }
    }

    const dataProviders = users.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      ram_usage: ramByOwner.has(u.username) ? ramByOwner.get(u.username) : null,
    }));

    return res.json({ status: 'SUCCESS', data_providers: dataProviders });
  } catch (err) {
    next(err);
  }
});

router.post('/data-provider-forms', verifyJWT, requireRole('data-provider'), async (req, res, next) => {
  try {
    const payload = req.body?.payload;
    if (!payload) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_PAYLOAD' });
    }

    const submissionId = await createDataProviderForm(payload);
    return res.status(201).json({ status: 'SUCCESS', submission_id: submissionId });
  } catch (err) {
    if (sendStoreError(res, err)) return;
    next(err);
  }
});

export default router;
