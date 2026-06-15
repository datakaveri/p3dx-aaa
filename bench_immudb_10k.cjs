#!/usr/bin/env node
// immuDB write/read latency microbench — N=10000 iterations
// Outputs RESULT lines parseable by harness.

const ImmudbClient = require('./node_modules/immudb-node/dist/src/client').default;

const HOST = '127.0.0.1';
const PORT = 3322;
const USER = 'anon_backend';
const PASS = 'AnonBackend@123';
const DB   = 'anon_audit_clean';

const N = parseInt(process.env.BENCH_N || '10000', 10);
const WARMUP = 100;

function percentile(sorted, p) {
  const idx = Math.floor((p / 100) * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

function report(label, samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(`RESULT ${label} n=${s.length} mean=${mean.toFixed(3)}ms p50=${percentile(s,50).toFixed(3)}ms p95=${percentile(s,95).toFixed(3)}ms p99=${percentile(s,99).toFixed(3)}ms min=${s[0].toFixed(3)}ms max=${s[s.length-1].toFixed(3)}ms`);
}

function hrMs(t0) {
  const diff = process.hrtime.bigint() - t0;
  return Number(diff) / 1e6;
}

process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED:', reason);
  process.exit(2);
});

async function main() {
  const client = new ImmudbClient({ host: HOST, port: PORT });
  await client.login({ user: USER, password: PASS });
  await client.useDatabase({ databasename: DB });
  console.error('Connected to immuDB');

  // Warm-up
  console.error(`Warm-up (${WARMUP} writes)...`);
  for (let i = 0; i < WARMUP; i++) {
    const k = `warmup-${i}-${Date.now()}`;
    await client.set({ key: k, value: `v${i}` });
  }

  // SET benchmark
  console.error(`SET benchmark (n=${N})...`);
  const writeKeys = [];
  const writeTimes = [];
  for (let i = 0; i < N; i++) {
    const k = `bench-set-${i}-${Date.now()}-${Math.random()}`;
    writeKeys.push(k);
    const t0 = process.hrtime.bigint();
    try {
      await client.set({ key: k, value: JSON.stringify({ ts: Date.now(), seq: i, payload: 'audit-entry' }) });
    } catch (e) {
      console.error(`SET fail at i=${i}:`, e.message || e);
      throw e;
    }
    writeTimes.push(hrMs(t0));
    if (i > 0 && i % 100 === 0) {
      console.error(`  ${i}/${N} batch[${Math.max(0,i-100)}..${i}] mean ~${(writeTimes.slice(-100).reduce((a,b)=>a+b,0)/100).toFixed(2)}ms`);
    }
  }
  report('audit_append', writeTimes);

  // GET benchmark
  console.error(`GET benchmark (n=${N})...`);
  const readTimes = [];
  for (let i = 0; i < N; i++) {
    const k = writeKeys[i];
    const t0 = process.hrtime.bigint();
    await client.get({ key: k });
    readTimes.push(hrMs(t0));
  }
  report('audit_lookup', readTimes);

  await client.logout();
}

main().catch(err => {
  console.error('Error:', err.message || err);
  process.exit(1);
});
