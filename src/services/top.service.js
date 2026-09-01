import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

// The TEE orchestrator API (POST /v1/tee/...) is mounted at gov_layer's
// server root, not under /api/v1 like buildTopUrl below — see
// p3dx_gov_layer/internal/httpapi/server.go's Handler().
function buildOrchestratorUrl(pathname) {
  const baseRaw = process.env.TEE_ORCHESTRATOR_URL;
  const base = typeof baseRaw === 'string' ? baseRaw.trim() : '';
  if (!base) {
    throw new Error('TEE_ORCHESTRATOR_URL_NOT_SET');
  }
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${trimmedBase}${path}`;
}

function buildTopUrl(pathname) {
  const baseUrlRaw = process.env.TOP_BASE_URL;
  const baseUrl = typeof baseUrlRaw === 'string' ? baseUrlRaw.trim() : '';
  if (!baseUrl) {
    throw new Error('TOP_BASE_URL_NOT_SET');
  }

  const endpointRaw = pathname ?? process.env.TOP_CONTRACT_ENDPOINT;
  const endpoint = typeof endpointRaw === 'string' && endpointRaw.trim() ? endpointRaw.trim() : '/contract';

  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const ep = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  return `${base}${ep}`;
}

// gov_layer's error responses are usually plain text (Go's http.Error), not
// JSON — axios still puts that string in resp.data. Handle both shapes so
// the real error reaches the browser instead of a generic "status N".
function govLayerErrorMessage(resp) {
  if (resp.data && typeof resp.data === 'object') {
    return resp.data.error || resp.data.message || `gov_layer returned status ${resp.status}`;
  }
  if (typeof resp.data === 'string' && resp.data.trim()) {
    return resp.data.trim();
  }
  return `gov_layer returned status ${resp.status}`;
}

function buildTopHeaders({ jwt }) {
  const modeRaw = process.env.TOP_AUTH_MODE;
  const mode = typeof modeRaw === 'string' ? modeRaw.trim().toLowerCase() : 'bearer';

  const headers = {
    'Content-Type': 'application/json',
  };

  if (mode === 'none') {
    return headers;
  }

  if (mode === 'apikey') {
    const apiKeyRaw = process.env.TOP_API_KEY;
    const apiKey = typeof apiKeyRaw === 'string' ? apiKeyRaw.trim() : '';
    if (!apiKey) {
      throw new Error('TOP_API_KEY_NOT_SET');
    }
    headers['x-api-key'] = apiKey;
    return headers;
  }

  if (!jwt) {
    throw new Error('TOP_JWT_MISSING');
  }
  headers.Authorization = `Bearer ${jwt}`;
  return headers;
}

/**
 * New endpoint — sends a raw workload request to TOP /workload.
 * TOP creates the contract, consumer-signs it, runs the full pipeline,
 * and returns { status, contract_id, contract } (the fully signed contract).
 */
export async function sendWorkloadToTop({ token, datasetId, applicationId }) {
  const enabledRaw = process.env.TOP_ENABLED;
  const enabled = typeof enabledRaw === 'string' ? enabledRaw.trim().toLowerCase() : 'false';
  if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') {
    return { sent: false, skipped: true };
  }

  const timeoutMsRaw = process.env.TOP_TIMEOUT_MS;
  const timeout = Number(timeoutMsRaw);

  const url = buildTopUrl('/workload');
  const headers = buildTopHeaders({ jwt: token });

  const payload = {
    access_token: token,
    dataset_id: datasetId,
    application_id: applicationId,
  };

  const resp = await axios.post(url, payload, {
    headers,
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 30000,
    validateStatus: () => true,
  });

  const ok = resp.status >= 200 && resp.status < 300;
  return {
    sent: ok,
    skipped: false,
    status: resp.status,
    data: resp.data,
  };
}

// Contract generation now happens in gov_layer itself (POST /generate-contract),
// not in this service. Unlike sendWorkloadToTop/sendContractToTop, this call is
// NOT gated behind TOP_ENABLED — it's the core generation path, not optional
// forwarding. Returns the unsigned contract for display; nothing is
// signed/stored/deployed by this call.
export async function generateContractFromGovLayer({ token, datasetId, datasetName, applicationId, technique, infraId }) {
  const url = buildTopUrl('/generate-contract');
  const headers = buildTopHeaders({ jwt: token });

  const resp = await axios.post(
    url,
    {
      dataset_id: datasetId,
      dataset_name: datasetName,
      application_id: applicationId,
      technique,
      // InfraCat selection — SMPC only, omitted entirely when absent so
      // TEE/FL callers and older clients keep sending exactly what they did before.
      ...(infraId ? { infra_id: infraId } : {}),
    },
    { headers, timeout: 10000, validateStatus: () => true }
  );

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(govLayerErrorMessage(resp));
  }

  return resp.data?.contract;
}

// Builds the TEEContract shape gov_layer's POST /v1/tee/provision (and
// /v1/tee/sessions) expects — mirrors p3dx_gov_layer/internal/services/
// tee_contract.go's json tags field-for-field, which itself mirrors p3dx-apd's
// domain.Contract. appDetails.imageId/imageHash are required by
// ValidateTEEContract but aren't compared against anything on this demo path
// (see that file's comments), so demo placeholders are fine here. Both the
// TEE and SMPC catalogue entry points call startTeeSession and get this same
// skald-anonymizer image — there's no separate SMPC workload image yet.
function buildTeeContract({ datasetUrl, datasetId, datasetName, consumerId }) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 30 * 60 * 1000); // 30-minute run window
  return {
    contractId: uuidv4(),
    requestId: uuidv4(),
    consumerId: consumerId || 'demo-consumer',
    providerId: 'demo-provider',
    appDetails: {
      imageId: 'skald-anonymizer',
      imageHash: 'unpinned-demo-measurement',
      version: '1.0',
    },
    datasetDetails: {
      itemId: datasetId || 'demo-dataset',
      assetName: datasetName || datasetId || 'demo-dataset',
      assetType: 'dataset',
      resourceUrl: datasetUrl,
    },
    accessConfig: { type: 'read' },
    consumerPublicKey: '',
    apdCallbackUrl: '',
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

function orchestratorErrorMessage(resp) {
  if (resp.data && typeof resp.data === 'object') {
    return resp.data.message || resp.data.error || `orchestrator returned status ${resp.status}`;
  }
  if (typeof resp.data === 'string' && resp.data.trim()) {
    return resp.data.trim();
  }
  return `orchestrator returned status ${resp.status}`;
}

// Starts a TEE run session — gov_layer sequences
// provision -> attest -> run -> poll -> output in the background (see
// POST /v1/tee/sessions in p3dx_gov_layer/internal/httpapi/tee_session.go)
// and returns immediately with a session id to poll; provisioning alone can
// take minutes (cold confidential-VM boot).
export async function startTeeSession({ datasetUrl, datasetId, datasetName, consumerId }) {
  const contract = buildTeeContract({ datasetUrl, datasetId, datasetName, consumerId });
  const url = buildOrchestratorUrl('/v1/tee/sessions');

  const resp = await axios.post(url, contract, {
    headers: { 'Content-Type': 'application/json' },
    timeout: 15000,
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const err = new Error(orchestratorErrorMessage(resp));
    err.status = resp.status;
    throw err;
  }

  return resp.data;
}

// Polls a TEE session's status (GET /v1/tee/sessions/{sessionId}).
export async function getTeeSessionStatus({ sessionId }) {
  const url = buildOrchestratorUrl(`/v1/tee/sessions/${encodeURIComponent(sessionId)}`);

  const resp = await axios.get(url, { timeout: 10000, validateStatus: () => true });

  if (resp.status < 200 || resp.status >= 300) {
    const err = new Error(orchestratorErrorMessage(resp));
    err.status = resp.status;
    throw err;
  }

  return resp.data;
}

// Fetches the anonymized output of a completed session
// (GET /v1/tee/sessions/{sessionId}/output) as a raw buffer to stream back
// to the browser, along with the content type gov_layer served it as.
export async function downloadTeeSessionOutput({ sessionId }) {
  const url = buildOrchestratorUrl(`/v1/tee/sessions/${encodeURIComponent(sessionId)}/output`);

  const resp = await axios.get(url, {
    timeout: 30000,
    responseType: 'arraybuffer',
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    const bodyText = Buffer.from(resp.data).toString('utf8');
    let message = bodyText.trim() || `orchestrator returned status ${resp.status}`;
    try {
      const parsed = JSON.parse(bodyText);
      message = parsed?.message || parsed?.error || message;
    } catch {
      // response wasn't JSON — the raw text set above is the message
    }
    const err = new Error(message);
    err.status = resp.status;
    throw err;
  }

  return {
    data: Buffer.from(resp.data),
    contentType: resp.headers['content-type'] || 'application/octet-stream',
    contentDisposition: resp.headers['content-disposition'],
  };
}

// Terminates a session's TEE instance (DELETE /v1/tee/sessions/{sessionId}) —
// deallocates the confidential VM so it stops billing compute.
export async function terminateTeeSession({ sessionId }) {
  const url = buildOrchestratorUrl(`/v1/tee/sessions/${encodeURIComponent(sessionId)}`);

  const resp = await axios.delete(url, { timeout: 30000, validateStatus: () => true });

  if (resp.status < 200 || resp.status >= 300) {
    const err = new Error(orchestratorErrorMessage(resp));
    err.status = resp.status;
    throw err;
  }

  return resp.data;
}

// Participation-consent notifications (gov_layer's fl_notifications.go),
// mounted at the same /api/v1 base as buildTopUrl above. Unlike POST
// /contract, these endpoints take no auth token — gov_layer doesn't gate
// them — so no buildTopHeaders/jwt is needed here.

// Creates one notification per recipient (POST /notifications). Used both for
// the initial participation request and for re-sends that carry updated
// selected/willing rosters.
export async function sendParticipationNotifications({ recipients, senderUsername, message, payload }) {
  const url = buildTopUrl('/notifications');
  const resp = await axios.post(
    url,
    { recipients, senderUsername, message, payload },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true }
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(govLayerErrorMessage(resp));
  }
  return resp.data;
}

// GET /notifications/{username} — notifications addressed to this recipient.
export async function getRecipientNotifications({ username }) {
  const url = buildTopUrl(`/notifications/${encodeURIComponent(username)}`);
  const resp = await axios.get(url, { timeout: 10000, validateStatus: () => true });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(govLayerErrorMessage(resp));
  }
  return resp.data?.notifications || [];
}

// GET /notifications/by-sender/{username} — notifications this output owner
// has sent, each carrying the recipient's accepted/declined response so far.
export async function getSentNotifications({ senderUsername }) {
  const url = buildTopUrl(`/notifications/by-sender/${encodeURIComponent(senderUsername)}`);
  const resp = await axios.get(url, { timeout: 10000, validateStatus: () => true });
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(govLayerErrorMessage(resp));
  }
  return resp.data?.notifications || [];
}

// PATCH /notifications/{id}/read — mark one notification read for its owner.
export async function markParticipationNotificationRead({ notificationId, username }) {
  const url = buildTopUrl(`/notifications/${encodeURIComponent(notificationId)}/read`);
  const resp = await axios.patch(
    url,
    { username },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true }
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(govLayerErrorMessage(resp));
  }
  return resp.data;
}

// POST /notifications/{id}/respond — a data provider accepts/declines their
// participation request. This is also what signs that provider's party on
// the session's contract (see p3dx_gov_layer db.SignDataProviderParty).
export async function respondToParticipationNotification({ notificationId, username, response, message }) {
  const url = buildTopUrl(`/notifications/${encodeURIComponent(notificationId)}/respond`);
  const resp = await axios.post(
    url,
    { username, response, message },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true }
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(govLayerErrorMessage(resp));
  }
  return resp.data;
}

// POST /contracts (gov_layer's fl_notifications-adjacent contracts.go) —
// assembles and stores the FL session contract from a submission_id + parties
// list. finalize=false on the initial participation request, finalize=true on
// the Final Roster send (only the confirmed/willing parties at that point).
// Each party may carry dataset_name/data_url pulled from that provider's APD
// form so the contract's data-provider entries aren't left blank.
export async function buildSessionContract({ submissionId, outputOwnerUserId, parties, finalize }) {
  const url = buildTopUrl('/contracts');
  const resp = await axios.post(
    url,
    {
      submission_id: submissionId,
      output_owner_user_id: outputOwnerUserId,
      parties,
      finalize: !!finalize,
    },
    { headers: { 'Content-Type': 'application/json' }, timeout: 10000, validateStatus: () => true }
  );
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(govLayerErrorMessage(resp));
  }
  return resp.data;
}

// GET /contract/{sessionId} (contracts.go) — reads back the stored FL session
// contract (draft or finalized) so the owner can view what was built.
export async function getSessionContract({ sessionId }) {
  const url = buildTopUrl(`/contract/${encodeURIComponent(sessionId)}`);
  const resp = await axios.get(url, { timeout: 10000, validateStatus: () => true });
  if (resp.status === 404) {
    return null;
  }
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(govLayerErrorMessage(resp));
  }
  return resp.data;
}

export async function sendContractToTop({ contract, jwt }) {
  const enabledRaw = process.env.TOP_ENABLED;
  const enabled = typeof enabledRaw === 'string' ? enabledRaw.trim().toLowerCase() : 'false';
  if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') {
    return { sent: false, skipped: true };
  }

  const timeoutMsRaw = process.env.TOP_TIMEOUT_MS;
  const timeout = Number(timeoutMsRaw);

  const url = buildTopUrl();
  const headers = buildTopHeaders({ jwt });

  const accessToken = contract?.access_token || jwt;
  const contractBody = contract?.contract || contract;
  const signature =
    contract?.signature ||
    contractBody?.signature ||
    contractBody?.signatures?.consumer_signature ||
    contractBody?.signatures?.consumerSignature;

  const payloadModeRaw = process.env.TOP_PAYLOAD_MODE;
  const payloadMode = typeof payloadModeRaw === 'string' ? payloadModeRaw.trim().toLowerCase() : 'wrapper';

  const payload =
    payloadMode === 'raw'
      ? contractBody
      : {
          access_token: accessToken,
          signature,
          contract: contractBody,
        };

  const resp = await axios.post(url, payload, {
    headers,
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 10000,
    validateStatus: () => true,
  });

  const ok = resp.status >= 200 && resp.status < 300;
  return {
    sent: ok,
    skipped: false,
    status: resp.status,
    data: resp.data,
  };
}
