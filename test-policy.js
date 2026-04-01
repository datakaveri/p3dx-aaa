/**
 * Policy Submission Test
 *
 * Flow: Login as data-provider → POST /p3dx/policy → verify APD accepted it
 *
 * Requires:
 *   - A user with the `data-provider` Keycloak realm role
 *   - APD running and reachable (APD_BASE_URL in .env)
 *
 * Env:
 *   BASE_URL              default: http://localhost:3001
 *   TEST_DP_USERNAME      (required) username of a data-provider user
 *   TEST_DP_PASSWORD      (required) password of that user
 *   DATASET_ID            default: ds-001
 */

import 'dotenv/config';
import axios from 'axios';
import { randomUUID } from 'crypto';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const DATASET_ID = process.env.DATASET_ID || 'ds-001';

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

async function main() {
  log('INIT', `Policy Submission Test  →  ${BASE_URL}`, colors.blue);
  console.log();

  const username = process.env.TEST_DP_USERNAME;
  const password = process.env.TEST_DP_PASSWORD;

  if (!username || !password) {
    log('ERROR', 'TEST_DP_USERNAME and TEST_DP_PASSWORD must be set in .env', colors.red);
    log('ERROR', 'These must be credentials for a user with the data-provider Keycloak role', colors.red);
    process.exit(1);
  }

  // ── 1. Login ───────────────────────────────────────────────────────────────
  log('STEP-1', `Logging in as data-provider: ${username}`, colors.blue);

  const loginRes = await axios.post(`${BASE_URL}/p3dx/login`, { username, password });
  const accessToken = loginRes.data.access_token;
  log('✓ PASS', 'Login OK', colors.green);
  console.log();

  // ── 2. Verify role ─────────────────────────────────────────────────────────
  log('STEP-2', 'Checking user roles via /p3dx/me...', colors.blue);

  const meRes = await axios.get(`${BASE_URL}/p3dx/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  const roles = meRes.data.user?.roles || [];
  if (!roles.includes('data-provider')) {
    log('✗ FAIL', `User "${username}" does not have the data-provider role (roles: ${roles.join(', ')})`, colors.red);
    process.exit(1);
  }

  log('✓ PASS', `Roles confirmed: ${roles.join(', ')}`, colors.green);
  console.log();

  // ── 3. Submit policy ───────────────────────────────────────────────────────
  const policyId = `policy-${randomUUID()}`;
  const payload = {
    policyId,
    itemId: DATASET_ID,
    issuedBy: username,
    rules: {
      dataset: { id: DATASET_ID },
      accessLevel: 'read',
      purpose: 'research',
    },
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
  };

  log('STEP-3', `Submitting policy for dataset ${DATASET_ID} (policyId: ${policyId})...`, colors.blue);

  let policyRes;
  try {
    policyRes = await axios.post(`${BASE_URL}/p3dx/policy`, payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });
  } catch (err) {
    if (err.response?.status === 503) {
      log('⚠ SKIP', 'APD is not configured (APD_BASE_URL not set) — policy proxy not available', colors.yellow);
      log('⚠ SKIP', 'Set APD_BASE_URL in .env and ensure APD is running to test policy submission', colors.yellow);
      process.exit(0);
    }
    throw err;
  }

  if (policyRes.status !== 201 || policyRes.data.status !== 'SUCCESS') {
    log('✗ FAIL', `Unexpected response: ${policyRes.status} ${JSON.stringify(policyRes.data)}`, colors.red);
    process.exit(1);
  }

  log('✓ PASS', 'Policy accepted by APD', colors.green);
  console.log();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`${colors.green}${'═'.repeat(60)}${colors.reset}`);
  log('SUCCESS', '✓ Policy submission test passed', colors.green);
  console.log(`  policyId  : ${policyId}`);
  console.log(`  itemId    : ${DATASET_ID}`);
  console.log(`  issuedBy  : ${username}`);
  console.log(`${colors.green}${'═'.repeat(60)}${colors.reset}`);
}

main().catch(err => {
  const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
  log('FATAL', detail, colors.red);
  process.exit(1);
});
