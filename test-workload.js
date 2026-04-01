/**
 * Workload Contract Test
 *
 * Flow: Register → Login → Run Workload → Verify Contract in immuDB
 *       → (if TOP is live) Fetch signed result
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
  const contractId = contract?.contract_id || contract?.contractId;
  const topResult = runRes.data.top;

  log('✓ PASS', `Workload submitted — contract_id: ${contractId}`, colors.green);
  log('  INFO', `TOP sent: ${topResult?.sent ?? false}  |  skipped: ${topResult?.skipped ?? false}`, colors.yellow);

  if (runRes.data.signed_contract) {
    log('  INFO', 'Signed contract returned inline (TOP was live)', colors.yellow);
  }

  console.log();

  // ── 3. Retrieve contract record ────────────────────────────────────────────
  log('STEP-3', `Fetching contract record (GET /p3dx/workloads/contracts/${contractId})...`, colors.blue);

  const getRes = await axios.get(
    `${BASE_URL}/p3dx/workloads/contracts/${contractId}`,
    { headers: authHeaders }
  );

  if (getRes.status !== 200 || getRes.data.status !== 'SUCCESS') {
    log('✗ FAIL', `Unexpected response: ${getRes.status}`, colors.red);
    process.exit(1);
  }

  log('✓ PASS', 'Contract record retrieved from immuDB', colors.green);
  console.log();

  // ── 4. Fetch signed result (only if TOP was live) ──────────────────────────
  if (topResult?.sent === true) {
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
      log('✓ PASS', 'Orchestrator signature present in signed contract', colors.green);
    }
  } else {
    log('STEP-4', 'TOP not live — skipping signed result fetch', colors.yellow);
  }

  console.log();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`${colors.green}${'═'.repeat(60)}${colors.reset}`);
  log('SUCCESS', '✓ Workload contract test passed', colors.green);
  console.log(`  contract_id : ${contractId}`);
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
