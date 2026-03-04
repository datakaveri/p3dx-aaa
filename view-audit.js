import pkg from 'immudb-node';
import 'dotenv/config';
const ImmudbClient = pkg.default;

const host = process.env.IMMUDB_HOST || '127.0.0.1';
const port = Number.parseInt(process.env.IMMUDB_PORT || '3322', 10);
const user = process.env.IMMUDB_USER || 'anon_backend';
const password = process.env.IMMUDB_PASSWORD;
const database = process.env.IMMUDB_DATABASE || 'anon_audit';

if (!password) {
  console.error('IMMUDB_PASSWORD is required. Set it in your local .env');
  process.exit(1);
}

const client = new ImmudbClient({
  host,
  port,
});

await client.login({
  user,
  password,
});

await client.useDatabase({ databasename: database });

// Get all audit events
const results = await client.scan({
  prefix: 'audit:',
  limit: 100,
});

console.log('Total entries found:', results.entriesList?.length || 0);
console.log('\n');

const events = [];
results.entriesList?.forEach(entry => {
  try {
    const parsed = JSON.parse(entry.value);
    // Only include primary keys (audit:uuid format)
    if (entry.key.match(/^audit:[a-f0-9\-]+$/)) {
      events.push(parsed);
    }
  } catch (e) {
    // skip parse errors
  }
});

// Display as table
if (events.length > 0) {
  console.table(events);
} else {
  console.log('No audit events found.');
}

process.exit(0);