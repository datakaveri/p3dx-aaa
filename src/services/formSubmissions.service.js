import { apdGet, apdPost, apdDelete } from './apdFormsClient.service.js';
import { pushSubmission, pushSubmissionDeleted, pushProviderForm } from './govLayerPush.service.js';

// APD is the store of record for FL forms (output-owner submissions and
// data-provider forms) — every write here is forwarded to APD's
// /api/v1/forms/* endpoints, which own id minting, numeric/string coercion,
// and the upsert-by-form_id behavior this file used to implement directly
// against immudb. Each write also pushes the resulting document to the
// governance layer (best-effort) so FL orchestration/reports have a local
// copy without pulling from aaa.

export async function createOutputOwnerSubmission(payload = {}) {
  const { data: doc } = await apdPost('/api/v1/forms/submissions', payload);
  await pushSubmission(doc);
  return doc.id;
}

// Note: the UI sends "RAM" (uppercase) while APD's field is "ram" — this
// quirk predates the move to APD and is kept as-is.
export async function createDataProviderForm(payload = {}) {
  const { data: doc } = await apdPost('/api/v1/forms/provider-forms', payload);
  await pushProviderForm(doc);
  return doc.id;
}

// Datasets are "available" from two sources: data-provider forms
// (dataset_name typed on the FL form) and policies (Set Policy page). Union
// the two so either path makes a dataset show up as available.
export async function listDatasetNames() {
  const [providerForms, policies] = await Promise.all([
    apdGet('/api/v1/forms/dataset-names'),
    apdGet('/api/v1/policy/datasets'),
  ]);
  const names = new Set([
    ...(Array.isArray(providerForms.data) ? providerForms.data : []),
    ...(Array.isArray(policies.data) ? policies.data : []),
  ]);
  return Array.from(names).sort();
}

export async function listSubmissions() {
  const { data } = await apdGet('/api/v1/forms/submissions');
  return Array.isArray(data) ? data : [];
}

export async function getSubmission(id) {
  const { data } = await apdGet(`/api/v1/forms/submissions/${encodeURIComponent(id)}`);
  return data || null;
}

export async function deleteSubmission(id) {
  const { status } = await apdDelete(`/api/v1/forms/submissions/${encodeURIComponent(id)}`);
  if (status === 404) return false;
  await pushSubmissionDeleted(id);
  return true;
}
