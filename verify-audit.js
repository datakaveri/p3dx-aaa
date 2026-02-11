/**
 * ImmuDB Audit Log Verification
 * Retrieves and displays audit events from immuDB
 */

import pkg from 'immudb-node';

const ImmudbClient = pkg.default;

async function scanAllByPrefix(client, prefix) {
  const results = [];
  let seekkey;

  for (;;) {
    const page = await client.scan({
      prefix,
      seekkey,
      limit: 1000,
    });

    const entries = page?.entriesList || [];
    if (entries.length === 0) {
      break;
    }

    results.push(...entries);

    const lastKey = entries[entries.length - 1]?.key;
    if (!lastKey || lastKey === seekkey) {
      break;
    }

    seekkey = lastKey + '\u0000';
  }

  return results;
}

async function verifyAuditLogs() {
  const client = new ImmudbClient({
    host: process.env.IMMUDB_HOST || '127.0.0.1',
    port: parseInt(process.env.IMMUDB_PORT || 3322),
  });

  try {
    console.log('🔐 Connecting to immuDB...');
    await client.login({
      user: process.env.IMMUDB_USER || 'anon_backend',
      password: process.env.IMMUDB_PASSWORD || 'AnonBackend@123',
    });

    console.log('✓ Connected to immuDB');

    // Select the audit database
    await client.useDatabase({
      databasename: process.env.IMMUDB_DATABASE || 'anon_audit',
    });

    console.log('✓ Selected database: anon_audit\n');

    // Scan for audit events
    console.log('📋 Retrieving audit events...\n');

    const results = await scanAllByPrefix(client, 'audit:');

    const primaryResults = results.filter(entry =>
      entry.key.match(/^audit:[a-f0-9-]{36}$/)
    );

    if (!primaryResults || primaryResults.length === 0) {
      console.log('ℹ No audit events found in database');
      return;
    }

    console.log(`Found ${primaryResults.length} audit event(s):\n`);
    console.log('═'.repeat(80));

    primaryResults.forEach((entry, index) => {
      try {
        const event = JSON.parse(entry.value);
        console.log(`\n[Event ${index + 1}]`);
        console.log(`  Event ID:      ${event.event_id}`);
        console.log(`  Event Type:    ${event.event_type}`);
        console.log(`  Subject ID:    ${event.subject_id}`);
        console.log(`  Occurred At:   ${event.occurred_at}`);
        
        if (event.metadata && event.metadata !== '{}') {
          try {
            const metadata = typeof event.metadata === 'string' 
              ? JSON.parse(event.metadata) 
              : event.metadata;
            console.log(`  Metadata:      ${JSON.stringify(metadata)}`);
          } catch (e) {
            console.log(`  Metadata:      ${event.metadata}`);
          }
        }
      } catch (e) {
        console.log(`  Raw Value: ${entry.value}`);
      }
    });

    console.log('\n' + '═'.repeat(80));
    console.log('\n✓ Audit verification complete');

  } catch (err) {
    console.error('✗ Error connecting to immuDB:', err.message);
    console.error('\nMake sure:');
    console.error('  1. immuDB is running on configured host/port');
    console.error('  2. Credentials are correct');
    console.error('  3. Database exists');
    process.exit(1);
  }
}

verifyAuditLogs();
