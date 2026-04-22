/**
 * Workload Contract Test
 *
 * Flow: Register/Login → Run Workload → Verify signed contract in response
 *       → Retrieve contract from immuDB → (if TOP live) Verify orchestrator signature
 *
 * In the new architecture, contract creation, consumer signing, orchestrator
 * signing, and TEE deployment all happen inside TOP (POST /workload).
 * p3dx-aaa forwards the raw workload params and receives the fully signed
 * contract back in the POST /workloads/run response — no separate GET needed.
 *
 * Env overrides (all optional):
 *   BASE_URL          default: http://localhost:3001
 *   TEST_USERNAME     use an existing user instead of auto-registering
 *   TEST_PASSWORD
 *   DATASET_ID        default: ds-001
 *   APPLICATION_ID    default: app-1
 */

import 'dotenv/config';
import axios from 'axios';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const DATASET_ID = process.env.DATASET_ID || 'ds-001';
const APPLICATION_ID = process.env.APPLICATION_ID || 'app-1';

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
};

function log(stage, msg, color = colors.reset) {
  console.log(`${color}[${stage}]${colors.reset} ${msg}`);
}

function randomSuffix() {
  return `${Date.now()}${Math.floor(Math.random() * 9999)}`;
}

async function main() {
  log('INIT', `Workload Contract Test  →  ${BASE_URL}`, colors.blue);
  log('INIT', `Dataset: ${DATASET_ID}  |  App: ${APPLICATION_ID}`, colors.blue);
  console.log();

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  let username = process.env.TEST_USERNAME;
  let password = process.env.TEST_PASSWORD;
  let accessToken;

  if (username && password) {
    log('STEP-1', `Logging in as existing user: ${username}`, colors.blue);
    const res = await axios.post(`${BASE_URL}/p3dx/login`, { username, password });
    accessToken = res.data.access_token;
    log('✓ PASS', 'Login OK', colors.green);
  } else {
    username = `workload_test_${randomSuffix()}`;
    password = `TestPass_${randomSuffix()}!`;
    log('STEP-1', `Registering test user: ${username}`, colors.blue);

    await axios.post(`${BASE_URL}/p3dx/register`, {
      username,
      email: `${username}@example.com`,
      password,
      firstName: 'Workload',
      lastName: 'Test',
    });
    log('✓ PASS', 'Registration OK', colors.green);

    const loginRes = await axios.post(`${BASE_URL}/p3dx/login`, { username, password });
    accessToken = loginRes.data.access_token;
    log('✓ PASS', 'Login OK', colors.green);
  }

  const authHeaders = { Authorization: `Bearer ${accessToken}` };
  console.log();

  // ── 2. Run workload ────────────────────────────────────────────────────────
  // p3dx-aaa forwards { access_token, dataset_id, application_id } to TOP.
  // TOP creates the contract, consumer-signs it, runs the pipeline, and returns
  // the fully signed contract. p3dx-aaa stores it in immuDB and returns it here.
  log('STEP-2', 'Submitting workload (POST /p3dx/workloads/run)...', colors.blue);

  const runRes = await axios.post(
    `${BASE_URL}/p3dx/workloads/run`,
    { datasetId: DATASET_ID, applicationId: APPLICATION_ID },
    { headers: { ...authHeaders, 'Content-Type': 'application/json' } }
  );

  if (runRes.status !== 201 || runRes.data.status !== 'SUCCESS') {
    log('✗ FAIL', `Unexpected response: ${runRes.status} ${JSON.stringify(runRes.data)}`, colors.red);
    process.exit(1);
  }

  const contract = runRes.data.contract;
  const contractId = runRes.data.contract_id || contract?.contract_id;
  const topResult = runRes.data.top;

  log('✓ PASS', `Workload submitted — contract_id: ${contractId ?? '(none — TOP disabled)'}`, colors.green);
  log('  INFO', `TOP sent: ${topResult?.sent ?? false}  |  skipped: ${topResult?.skipped ?? false}`, colors.yellow);

  if (!topResult?.sent && !topResult?.skipped) {
    log('  WARN', `TOP error: ${JSON.stringify(topResult)}`, colors.yellow);
  }

  // The response now carries the fully signed contract directly (no separate GET).
  if (contract) {
    const sigs = contract.signatures;
    if (sigs?.consumer_signature) {
      log('✓ PASS', 'Consumer signature present (HMAC-SHA256 produced by TOP)', colors.green);
    }
    if (sigs?.orchestrator_signature) {
      log('✓ PASS', 'Orchestrator signature present (RSA-PKCS1v15-SHA256 produced by TOP)', colors.green);
    }
  } else {
    log('  INFO', 'No contract in response — TOP was disabled or skipped', colors.yellow);
  }

  console.log();

  // ── 3. Retrieve contract from immuDB ────────────────────────────────────────
  // p3dx-aaa stores the signed contract in immuDB after receiving it from TOP.
  // This step verifies that the audit record exists and is retrievable.
  if (contractId) {
    log('STEP-3', `Fetching contract record from immuDB (GET /p3dx/workloads/contracts/${contractId})...`, colors.blue);

    const getRes = await axios.get(
      `${BASE_URL}/p3dx/workloads/contracts/${contractId}`,
      { headers: authHeaders }
    );

    if (getRes.status !== 200 || getRes.data.status !== 'SUCCESS') {
      log('✗ FAIL', `Unexpected response: ${getRes.status}`, colors.red);
      process.exit(1);
    }

    log('✓ PASS', 'Contract record retrieved from immuDB', colors.green);
  } else {
    log('STEP-3', 'No contract_id — skipping immuDB retrieval (TOP was disabled)', colors.yellow);
  }

  console.log();

  // ── 4. Fetch workload result from TOP ──────────────────────────────────────
  // The signed contract is already in the run response, but this step verifies
  // that TOP's GET /contracts/:id endpoint is working and returns consistent data.
  if (topResult?.sent === true && contractId) {
    log('STEP-4', `Fetching workload result (GET /p3dx/workloads/contracts/${contractId}/result)...`, colors.blue);

    const resultRes = await axios.get(
      `${BASE_URL}/p3dx/workloads/contracts/${contractId}/result`,
      { headers: authHeaders }
    );

    if (resultRes.status !== 200 || resultRes.data.status !== 'SUCCESS') {
      log('✗ FAIL', `Result fetch failed: ${resultRes.status}`, colors.red);
      process.exit(1);
    }

    log('✓ PASS', `TEE status: ${resultRes.data.tee_status}`, colors.green);

    const sig = resultRes.data.signed_contract?.signatures;
    if (sig?.orchestrator_signature) {
      log('✓ PASS', 'Orchestrator signature confirmed via /result endpoint', colors.green);
    }
  } else {
    log('STEP-4', 'TOP not live — skipping /result verification', colors.yellow);
  }

  console.log();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`${colors.green}${'═'.repeat(60)}${colors.reset}`);
  log('SUCCESS', '✓ Workload contract test passed', colors.green);
  console.log(`  contract_id : ${contractId ?? '(none)'}`);
  console.log(`  dataset     : ${DATASET_ID}`);
  console.log(`  application : ${APPLICATION_ID}`);
  console.log(`  TOP sent    : ${topResult?.sent ?? false}`);
  console.log(`${colors.green}${'═'.repeat(60)}${colors.reset}`);
}

main().catch(err => {
  const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
  log('FATAL', detail, colors.red);
  process.exit(1);
});
