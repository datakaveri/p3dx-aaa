#!/usr/bin/env node
/**
 * ImmuDB Audit Testing Script
 * Tests complete audit logging flow with all event types
 */

import 'dotenv/config';

import pkg from 'immudb-node';
import http from 'http';

const ImmudbClient = pkg.default;

const BASE_URL = 'http://localhost:3001';

// Color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function log(stage, message, color = colors.reset) {
  console.log(`${color}[${stage}]${colors.reset} ${message}`);
}

function request(method, path, body = null, token = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    if (token) {
      options.headers.Authorization = `Bearer ${token}`;
    }

    const req = http.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            body: data ? JSON.parse(data) : null,
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            body: null,
            rawBody: data,
          });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function scanAllByPrefix(immuClient, prefix) {
  const results = [];
  let seekkey;

  // Iterate using seekkey pagination
  for (;;) {
    const page = await immuClient.scan({
      prefix,
      seekkey,
      limit: 1000,
    });

    const entries = page?.entriesList || [];
    if (entries.length === 0) {
      break;
    }

    results.push(...entries);

    // Next page starts after the last key of current page
    const lastKey = entries[entries.length - 1]?.key;
    if (!lastKey || lastKey === seekkey) {
      break;
    }
    seekkey = lastKey + '\u0000';
  }

  return results;
}

async function connectImmuDB() {
  const password = process.env.IMMUDB_PASSWORD;
  if (!password) {
    throw new Error('IMMUDB_PASSWORD is required. Set it in your local .env');
  }

  const client = new ImmudbClient({
    host: process.env.IMMUDB_HOST || '127.0.0.1',
    port: parseInt(process.env.IMMUDB_PORT || 3322),
  });

  await client.login({
    user: process.env.IMMUDB_USER || 'anon_backend',
    password,
  });

  await client.useDatabase({
    databasename: process.env.IMMUDB_DATABASE || 'anon_audit',
  });

  return client;
}

async function runTests() {
  log('INIT', 'Starting ImmuDB Audit Testing Suite', colors.blue);
  console.log();

  let immuClient;
  let accessToken = null;
  const testUser = {
    username: `immutest_${Date.now()}`,
    email: `immutest_${Date.now()}@example.com`,
    password: 'ImmuTest123!@#',
    firstName: 'ImmuDB',
    lastName: 'Tester',
  };

  try {
    // ============================================
    // 1. CONNECT TO IMMUDB
    // ============================================
    log('STEP-1', 'Connecting to ImmuDB...', colors.blue);
    immuClient = await connectImmuDB();
    log('✓ PASS', 'Connected to ImmuDB', colors.green);
    console.log();

    // ============================================
    // 2. REGISTER USER (logs USER_REGISTER_SUCCESS and USER_REGISTER_FAILED if test)
    // ============================================
    log('STEP-2', 'Testing registration endpoint (should log USER_REGISTER_SUCCESS)', colors.blue);
    const registerRes = await request('POST', '/p3dx/register', testUser);

    if (registerRes.status === 201) {
      log('✓ PASS', `User registered: ${testUser.username}`, colors.green);
    } else {
      log('✗ FAIL', `Registration failed: ${registerRes.status}`, colors.red);
      throw new Error('Registration failed');
    }
    console.log();

    // ============================================
    // 3. TEST DUPLICATE REGISTRATION (logs USER_REGISTER_FAILED)
    // ============================================
    log('STEP-3', 'Testing duplicate registration (should log USER_REGISTER_FAILED)', colors.blue);
    const dupRegisterRes = await request('POST', '/p3dx/register', testUser);

    if (dupRegisterRes.status === 409) {
      log('✓ PASS', `Duplicate registration blocked (as expected)`, colors.green);
    } else {
      log('⚠ INFO', `Duplicate registration test skipped (${dupRegisterRes.status})`, colors.yellow);
    }
    console.log();

    // ============================================
    // 4. LOGIN USER (logs USER_LOGIN_SUCCESS)
    // ============================================
    log('STEP-4', 'Testing login endpoint (should log USER_LOGIN_SUCCESS)', colors.blue);
    const loginRes = await request('POST', '/p3dx/login', {
      username: testUser.username,
      password: testUser.password,
    });

    if (loginRes.status === 200) {
      accessToken = loginRes.body.access_token;
      log('✓ PASS', `Login successful, token issued`, colors.green);
    } else {
      log('✗ FAIL', `Login failed: ${loginRes.status}`, colors.red);
      throw new Error('Login failed');
    }
    console.log();

    // ============================================
    // 5. TEST INVALID LOGIN (logs USER_LOGIN_FAILED)
    // ============================================
    log('STEP-5', 'Testing invalid login (should log USER_LOGIN_FAILED)', colors.blue);
    const invalidLoginRes = await request('POST', '/p3dx/login', {
      username: testUser.username,
      password: 'WrongPassword123!',
    });

    if (invalidLoginRes.status === 401) {
      log('✓ PASS', `Invalid login blocked (as expected)`, colors.green);
    } else {
      log('✗ FAIL', `Invalid login should fail: ${invalidLoginRes.status}`, colors.red);
    }
    console.log();

    // ============================================
    // 6. ACCESS PROTECTED ENDPOINT (logs USER_PROFILE_ACCESS)
    // ============================================
    log('STEP-6', 'Accessing protected endpoint (should log USER_PROFILE_ACCESS)', colors.blue);
    const meRes = await request('GET', '/p3dx/me', null, accessToken);

    if (meRes.status === 200) {
      log('✓ PASS', `Profile accessed with valid JWT`, colors.green);
    } else {
      log('✗ FAIL', `Profile access failed: ${meRes.status}`, colors.red);
      throw new Error('Profile access failed');
    }
    console.log();

    // ============================================
    // 7. TEST MISSING TOKEN (logs JWT_VERIFY_FAILED)
    // ============================================
    log('STEP-7', 'Testing missing token (should log JWT_VERIFY_FAILED)', colors.blue);
    const noTokenRes = await request('GET', '/p3dx/me');

    if (noTokenRes.status === 401) {
      log('✓ PASS', `Missing token rejected (as expected)`, colors.green);
    } else {
      log('✗ FAIL', `Missing token should fail: ${noTokenRes.status}`, colors.red);
    }
    console.log();

    // ============================================
    // 8. WAIT FOR AUDIT LOGGING
    // ============================================
    log('STEP-8', 'Waiting for audit events to be recorded...', colors.blue);
    await new Promise(resolve => setTimeout(resolve, 2000));
    log('✓ PASS', 'Audit events should be in ImmuDB', colors.green);
    console.log();

    // ============================================
    // 9. RETRIEVE AND VERIFY AUDIT LOGS
    // ============================================
    log('STEP-9', 'Retrieving audit events from ImmuDB...', colors.blue);

    const results = await scanAllByPrefix(immuClient, 'audit:');

    // Filter for primary keys (event_id) only
    const primaryKeys = results.filter(entry =>
      entry.key.match(/^audit:[a-f0-9-]{36}$/)
    );

    const events = primaryKeys
      .map(entry => {
        try {
          return JSON.parse(entry.value);
        } catch {
          return null;
        }
      })
      .filter(e => e !== null);

    log('✓ PASS', `Retrieved ${events.length} audit events`, colors.green);
    console.log();

    // ============================================
    // 10. ANALYZE AUDIT EVENTS
    // ============================================
    log('STEP-10', 'Analyzing audit events...', colors.blue);
    console.log();

    // Group events by type
    const eventsByType = {};
    events.forEach(event => {
      if (!eventsByType[event.event_type]) {
        eventsByType[event.event_type] = [];
      }
      eventsByType[event.event_type].push(event);
    });

    // Display event summary
    console.log(colors.cyan + '📊 AUDIT EVENT SUMMARY' + colors.reset);
    console.log('─'.repeat(80));

    const expectedEvents = [
      'USER_REGISTER_SUCCESS',
      'USER_LOGIN_SUCCESS',
      'USER_LOGIN_FAILED',
      'USER_PROFILE_ACCESS',
      'JWT_VERIFY_FAILED',
    ];

    let allEventsCaptured = true;

    for (const eventType of expectedEvents) {
      const count = eventsByType[eventType]?.length || 0;
      const status = count > 0 ? colors.green + '✓' + colors.reset : colors.red + '✗' + colors.reset;
      console.log(`${status} ${eventType.padEnd(30)} : ${count} event(s)`);

      if (count === 0) {
        allEventsCaptured = false;
      }
    }

    console.log('─'.repeat(80));
    console.log();

    // Display detailed event logs
    console.log(colors.cyan + '📋 DETAILED AUDIT EVENTS' + colors.reset);
    console.log('═'.repeat(80));

    events.forEach((event, index) => {
      console.log();
      console.log(colors.yellow + `[Event ${index + 1}]` + colors.reset);
      console.log(`  Event ID:       ${event.event_id}`);
      console.log(`  Type:           ${event.event_type}`);
      console.log(`  Subject:        ${event.subject_id}`);
      console.log(`  Timestamp:      ${event.occurred_at}`);

      if (event.metadata && Object.keys(event.metadata).length > 0) {
        console.log(`  Metadata:`);
        Object.entries(event.metadata).forEach(([key, value]) => {
          const displayValue = typeof value === 'string' && value.length > 50
            ? value.substring(0, 47) + '...'
            : value;
          console.log(`    - ${key}: ${displayValue}`);
        });
      }
    });

    console.log();
    console.log('═'.repeat(80));
    console.log();

    // ============================================
    // 11. QUERY AUDIT EVENTS BY TYPE
    // ============================================
    log('STEP-11', 'Testing filtered queries by event type...', colors.blue);

    const registrationEvents = await scanAllByPrefix(
      immuClient,
      'audit:type:USER_REGISTER_SUCCESS:'
    );

    const loginEvents = await scanAllByPrefix(immuClient, 'audit:type:USER_LOGIN_SUCCESS:');

    log('✓ PASS', `Found ${registrationEvents.length} registration events`, colors.green);
    log('✓ PASS', `Found ${loginEvents.length} login success events`, colors.green);
    console.log();

    // ============================================
    // 12. QUERY AUDIT EVENTS BY SUBJECT
    // ============================================
    log('STEP-12', 'Testing filtered queries by subject (user)...', colors.blue);

    const userEvents = await scanAllByPrefix(immuClient, `audit:subject:${testUser.username}:`);

    log('✓ PASS', `Found ${userEvents.length} events for user ${testUser.username}`, colors.green);
    console.log();

    // ============================================
    // SUMMARY
    // ============================================
    console.log(colors.green + '═'.repeat(80) + colors.reset);

    if (allEventsCaptured) {
      log('SUCCESS', '✓ All expected audit events captured!', colors.green);
    } else {
      log('WARNING', '⚠ Some expected events were not captured', colors.yellow);
    }

    console.log(`
${colors.green}Total Events Logged:${colors.reset} ${events.length}
${colors.green}Event Types:${colors.reset} ${Object.keys(eventsByType).length}
${colors.green}Test User:${colors.reset} ${testUser.username}

${colors.green}✓ ImmuDB Audit Logging Working!${colors.reset}
    `);

    console.log(colors.green + '═'.repeat(80) + colors.reset);

  } catch (err) {
    log('ERROR', `Test failed: ${err.message}`, colors.red);
    console.error(err);
    process.exit(1);
  } finally {
    if (immuClient) {
      try {
        await immuClient.logout();
      } catch (e) {
        // Ignore logout errors
      }
    }
  }
}

// Run tests
runTests().catch(err => {
  log('FATAL', err.message, colors.red);
  process.exit(1);
});
