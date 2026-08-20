// Pushes form data to the governance layer right after aaa stores it, so FL
// orchestration/reports have a local copy instead of pulling from aaa on
// every request. Best-effort: a governance-layer outage must not block a
// user's form submission, so failures are logged and swallowed.

function govLayerUrl(path) {
  const base = String(process.env.GOV_LAYER_URL || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}${path}`;
}

function pushHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = String(process.env.FORMS_PUSH_TOKEN || '').trim();
  if (token) headers['X-Forms-Push-Token'] = token;
  return headers;
}

async function pushBestEffort(url, options, label) {
  if (!url) return;
  try {
    const res = await fetch(url, options);
    if (!res.ok) {
      console.warn(`[gov-layer-push] ${label} failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.warn(`[gov-layer-push] ${label} failed: ${err.message}`);
  }
}

export async function pushSubmission(doc) {
  await pushBestEffort(
    govLayerUrl('/internal/forms/submissions'),
    { method: 'POST', headers: pushHeaders(), body: JSON.stringify({ submission: doc }) },
    `push submission ${doc?.id}`
  );
}

export async function pushSubmissionDeleted(id) {
  await pushBestEffort(
    govLayerUrl(`/internal/forms/submissions/${encodeURIComponent(id)}`),
    { method: 'DELETE', headers: pushHeaders() },
    `push submission delete ${id}`
  );
}

export async function pushProviderForm(doc) {
  await pushBestEffort(
    govLayerUrl('/internal/forms/provider-forms'),
    { method: 'POST', headers: pushHeaders(), body: JSON.stringify({ form: doc }) },
    `push provider form ${doc?.id}`
  );
}
