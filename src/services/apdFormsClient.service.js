// Thin HTTP client for APD's FL form endpoints (/api/v1/forms/*). APD is the
// store of record for form submissions and data-provider forms — see
// formSubmissions.service.js. Reuses APD_BASE_URL (already configured for the
// /p3dx/policy proxy) and sends the same shared secret used for the
// governance-layer forms push, so no new env vars are needed.

function apdBaseUrl() {
  const raw = process.env.APD_BASE_URL;
  return typeof raw === 'string' ? raw.trim().replace(/\/+$/, '') : '';
}

function apdUrl(path) {
  const base = apdBaseUrl();
  return base ? `${base}${path}` : null;
}

function apdHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = String(process.env.FORMS_PUSH_TOKEN || '').trim();
  if (token) headers['X-Forms-Push-Token'] = token;
  return headers;
}

async function parseBody(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class APDNotConfiguredError extends Error {
  constructor() {
    super('APD_NOT_CONFIGURED');
    this.name = 'APDNotConfiguredError';
  }
}

export class APDRequestError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `APD request failed: HTTP ${status}`);
    this.name = 'APDRequestError';
    this.status = status;
    this.body = body;
  }
}

async function apdRequest(method, path, payload) {
  const url = apdUrl(path);
  if (!url) throw new APDNotConfiguredError();

  const res = await fetch(url, {
    method,
    headers: apdHeaders(),
    body: payload !== undefined ? JSON.stringify(payload) : undefined,
  });

  // 404 is a normal "not found" result for GET/DELETE, not a failure.
  if (res.status === 404) return { status: 404, data: null };

  const body = await parseBody(res);
  if (!res.ok) {
    throw new APDRequestError(res.status, body);
  }
  return { status: res.status, data: body?.data ?? null };
}

export function apdGet(path) {
  return apdRequest('GET', path);
}

export function apdPost(path, payload) {
  return apdRequest('POST', path, payload);
}

export function apdDelete(path) {
  return apdRequest('DELETE', path);
}
