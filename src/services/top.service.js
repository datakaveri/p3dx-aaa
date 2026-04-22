import axios from 'axios';

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
