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
//
// The two sources disagree on identity: provider forms have no id at all
// (provider_forms carries only dataset_name), while policies are keyed by a
// real item_id that a later by-item policy lookup (Generate Contract) needs
// verbatim — sending the display name there misses, since the policies
// table's item_id column holds the Dataset ID the provider typed on Set
// Policy, not the Dataset name. So each entry here carries {id, name}: for
// policy-backed datasets `id` is the real item_id; for provider-form-only
// datasets (no policy set yet) `id` falls back to the name itself, since
// that's the only handle FetchDatasetForm's own by-name lookup uses anyway.
// When the same name exists in both sources, the policy's real item_id wins.
export async function listDatasetNames() {
  const [providerForms, policies] = await Promise.all([
    apdGet('/api/v1/forms/dataset-names'), // string[] of names, no id
    apdGet('/api/v1/policy/datasets'),     // [{item_id, name}]
  ]);
  const byName = new Map();
  for (const name of (Array.isArray(providerForms.data) ? providerForms.data : [])) {
    if (name) byName.set(name, { id: name, name });
  }
  for (const d of (Array.isArray(policies.data) ? policies.data : [])) {
    if (d?.name) byName.set(d.name, { id: d.item_id, name: d.name });
  }
  return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

// Infrastructure Catalogue (InfraCat) — every registered infra-provider's
// latest policy, for the SMPC workload catalogue's infrastructure picker.
// Unlike datasets, infra data only ever lives in policies (no provider-form
// analog), so no union is needed here.
export async function listAvailableInfrastructure() {
  const { data } = await apdGet('/api/v1/policy/infrastructure');
  return Array.isArray(data) ? data : [];
}

// Full registered detail for one infra-provider policy (capacity/attestation/
// platform) — powers the "expand for details" row in InfraCat. Unlike the
// list endpoint, only returns the `infrastructure` block, not the whole
// Policy (avoids leaking provider_id/provider_email to the browser).
export async function getInfrastructureDetails(itemId) {
  const { data } = await apdGet(`/api/v1/policy/by-item/${encodeURIComponent(itemId)}`);
  return data?.rules?.infrastructure || null;
}

// All data-provider forms ever submitted, most-recently-submitted first
// (APD's default order with no dataset_name filter). Used to look up each
// registered data provider's latest declared RAM usage.
export async function listProviderForms() {
  const { data } = await apdGet('/api/v1/forms/provider-forms');
  return Array.isArray(data) ? data : [];
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
