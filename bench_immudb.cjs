#!/usr/bin/env node
// immuDB write/read latency benchmark

const ImmudbClient = require('./node_modules/immudb-node/dist/src/client').default;

const HOST = '127.0.0.1';
const PORT = 3322;
const USER = 'anon_backend';
const PASS = 'AnonBackend@123';
const DB   = 'anon_audit_clean';

const N = 200; // number of iterations per operation

function percentile(sorted, p) {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(label, samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(`${label}: n=${s.length} mean=${mean.toFixed(2)}ms p50=${percentile(s,50)}ms p95=${percentile(s,95)}ms p99=${percentile(s,99)}ms min=${s[0]}ms max=${s[s.length-1]}ms`);
}

async function main() {
  const client = new ImmudbClient({ host: HOST, port: PORT });

  console.log('Connecting to immuDB...');
  await client.login({ user: USER, password: PASS });
  await client.useDatabase({ databasename: DB });
  console.log('Connected.\n');

  // Warm-up: 10 writes
  console.log('Warm-up (10 writes)...');
  for (let i = 0; i < 10; i++) {
    const k = `warmup-${i}-${Date.now()}`;
    await client.set({ key: k, value: `v${i}` });
  }
  console.log('Warm-up done.\n');

  // Benchmark: SET (write)
  const writeKeys = [];
  const writeTimes = [];
  console.log(`Benchmarking SET (n=${N})...`);
  for (let i = 0; i < N; i++) {
    const k = `bench-write-${i}-${Date.now()}`;
    writeKeys.push(k);
    const t0 = Date.now();
    await client.set({ key: k, value: JSON.stringify({ ts: Date.now(), seq: i, data: 'audit-entry-payload-here' }) });
    writeTimes.push(Date.now() - t0);
  }
  stats('SET latency', writeTimes);

  // Benchmark: GET (read, existing keys)
  const readTimes = [];
  console.log(`\nBenchmarking GET (n=${N}, reading back written keys)...`);
  for (let i = 0; i < N; i++) {
    const k = writeKeys[i];
    const t0 = Date.now();
    await client.get({ key: k });
    readTimes.push(Date.now() - t0);
  }
  stats('GET latency', readTimes);

  // Overall throughput estimate
  const totalWriteMs = writeTimes.reduce((a, b) => a + b, 0);
  const writeThroughput = (N / (totalWriteMs / 1000)).toFixed(1);
  console.log(`\nWrite throughput (sequential): ~${writeThroughput} ops/s`);
  const totalReadMs = readTimes.reduce((a, b) => a + b, 0);
  const readThroughput = (N / (totalReadMs / 1000)).toFixed(1);
  console.log(`Read throughput (sequential):  ~${readThroughput} ops/s`);

  await client.logout();
  console.log('\nDone.');
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
