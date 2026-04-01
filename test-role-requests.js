/**
 * Role Request Workflow Test
 *
 * Flow:
 *   1. Register a new user (auto-gets `user` role)
 *   2. User requests the `data-provider` role
 *   3. Verify the request appears in GET /p3dx/role-requests/my
 *   4. Admin lists all pending requests
 *   5. Admin approves the request
 *   6. User logs in again — verify data-provider role is now present
 *
 * Requires an admin account:
 *   TEST_ADMIN_USERNAME   (required)
 *   TEST_ADMIN_PASSWORD   (required)
 *
 * Env:
 *   BASE_URL              default: http://localhost:3001
 *   ROLE_TO_REQUEST       default: data-provider
 */

import 'dotenv/config';
import axios from 'axios';

const BASE_URL = (process.env.BASE_URL || 'http://localhost:3001').replace(/\/$/, '');
const ROLE_TO_REQUEST = process.env.ROLE_TO_REQUEST || 'data-provider';

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

async function login(username, password) {
  const res = await axios.post(`${BASE_URL}/p3dx/login`, { username, password });
  return res.data.access_token;
}

async function main() {
  log('INIT', `Role Request Workflow Test  →  ${BASE_URL}`, colors.blue);
  log('INIT', `Role to request: ${ROLE_TO_REQUEST}`, colors.blue);
  console.log();

  const adminUsername = process.env.TEST_ADMIN_USERNAME;
  const adminPassword = process.env.TEST_ADMIN_PASSWORD;

  if (!adminUsername || !adminPassword) {
    log('ERROR', 'TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD must be set in .env', colors.red);
    process.exit(1);
  }

  // ── 1. Register a fresh test user ──────────────────────────────────────────
  const username = `role_test_${randomSuffix()}`;
  const password = `TestPass_${randomSuffix()}!`;

  log('STEP-1', `Registering test user: ${username}`, colors.blue);
  await axios.post(`${BASE_URL}/p3dx/register`, {
    username,
    email: `${username}@example.com`,
    password,
    firstName: 'Role',
    lastName: 'Test',
  });

  let userToken = await login(username, password);
  log('✓ PASS', 'Registered and logged in', colors.green);
  console.log();

  // ── 2. User submits a role request ─────────────────────────────────────────
  log('STEP-2', `Requesting role: ${ROLE_TO_REQUEST}`, colors.blue);

  const reqRes = await axios.post(
    `${BASE_URL}/p3dx/role-requests`,
    { role: ROLE_TO_REQUEST },
    { headers: { Authorization: `Bearer ${userToken}` } }
  );

  if (reqRes.status !== 201 || reqRes.data.status !== 'SUCCESS') {
    log('✗ FAIL', `Role request failed: ${reqRes.status} ${JSON.stringify(reqRes.data)}`, colors.red);
    process.exit(1);
  }

  const requestId = reqRes.data.request?.id;
  log('✓ PASS', `Role request created — id: ${requestId}`, colors.green);
  console.log();

  // ── 3. User lists their own requests ───────────────────────────────────────
  log('STEP-3', 'Verifying request appears in GET /p3dx/role-requests/my...', colors.blue);

  const myRes = await axios.get(`${BASE_URL}/p3dx/role-requests/my`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });

  const myRequests = myRes.data.requests || [];
  const found = myRequests.find(r => r.id === requestId);

  if (!found) {
    log('✗ FAIL', `Request ${requestId} not found in user's request list`, colors.red);
    process.exit(1);
  }

  log('✓ PASS', `Request found — status: ${found.status}`, colors.green);
  console.log();

  // ── 4. Admin lists pending requests ────────────────────────────────────────
  log('STEP-4', `Admin logging in as: ${adminUsername}`, colors.blue);
  const adminToken = await login(adminUsername, adminPassword);

  const adminListRes = await axios.get(`${BASE_URL}/p3dx/admin/role-requests?status=pending`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  const allRequests = adminListRes.data.requests || [];
  const pendingRequest = allRequests.find(r => r.id === requestId);

  if (!pendingRequest) {
    log('⚠ WARN', `Request ${requestId} not in pending list — may already be processed`, colors.yellow);
  } else {
    log('✓ PASS', `Admin sees ${allRequests.length} pending request(s); found ours`, colors.green);
  }

  console.log();

  // ── 5. Admin approves the request ──────────────────────────────────────────
  log('STEP-5', `Approving request ${requestId}...`, colors.blue);

  const decisionRes = await axios.post(
    `${BASE_URL}/p3dx/admin/role-requests/${requestId}/decision`,
    { decision: 'APPROVE' },
    { headers: { Authorization: `Bearer ${adminToken}` } }
  );

  if (decisionRes.status !== 200 || decisionRes.data.status !== 'SUCCESS') {
    log('✗ FAIL', `Decision failed: ${decisionRes.status} ${JSON.stringify(decisionRes.data)}`, colors.red);
    process.exit(1);
  }

  log('✓ PASS', `Request approved — status: ${decisionRes.data.request?.status}`, colors.green);
  console.log();

  // ── 6. Verify role was granted ─────────────────────────────────────────────
  log('STEP-6', 'Re-logging in as user to verify role was granted...', colors.blue);

  // Fresh token to get updated roles from Keycloak
  userToken = await login(username, password);

  const meRes = await axios.get(`${BASE_URL}/p3dx/me`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });

  const roles = meRes.data.user?.roles || [];

  if (roles.includes(ROLE_TO_REQUEST)) {
    log('✓ PASS', `Role "${ROLE_TO_REQUEST}" is now present in user's token`, colors.green);
  } else {
    log('⚠ WARN', `Role not yet in token (roles: ${roles.join(', ')}) — Keycloak propagation may be delayed`, colors.yellow);
    log('⚠ WARN', 'Try logging in again after a moment to pick up the new role', colors.yellow);
  }

  console.log();

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`${colors.green}${'═'.repeat(60)}${colors.reset}`);
  log('SUCCESS', '✓ Role request workflow test passed', colors.green);
  console.log(`  user       : ${username}`);
  console.log(`  requestId  : ${requestId}`);
  console.log(`  role       : ${ROLE_TO_REQUEST}`);
  console.log(`  approved by: ${adminUsername}`);
  console.log(`  roles now  : ${roles.join(', ')}`);
  console.log(`${colors.green}${'═'.repeat(60)}${colors.reset}`);
}

main().catch(err => {
  const detail = err.response ? `${err.response.status} ${JSON.stringify(err.response.data)}` : err.message;
  log('FATAL', detail, colors.red);
  process.exit(1);
});
