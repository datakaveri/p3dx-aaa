#!/bin/bash
# End-to-end pipeline latency benchmark
# Measures POST /p3dx/workloads/run response time over N iterations

N=50
TOKEN_FILE=/tmp/bench_token.txt

# Get fresh token
curl -s -X POST http://localhost:8080/realms/master/protocol/openid-connect/token \
  -d "grant_type=password&client_id=anon-backend&client_secret=77WIVE7zmEJQzXLxjtFTcRL3uUthcSKQ&username=test&password=BenchTest@123" | \
  node -e "process.stdin.on('data',d=>process.stdout.write(JSON.parse(d).access_token))" > "$TOKEN_FILE"

TOKEN=$(cat "$TOKEN_FILE")
echo "Token obtained: ${#TOKEN} chars"
echo ""

TIMES=()

# Warm-up: 3 calls
echo "Warm-up (3 calls)..."
for i in 1 2 3; do
  curl -s -o /dev/null -X POST http://localhost:3001/p3dx/workloads/run \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"datasetId":"test-dataset-bench-001","applicationId":"bench-app-001"}'
done
echo "Warm-up done."
echo ""
echo "Benchmarking n=$N..."

for i in $(seq 1 $N); do
  START=$(date +%s%3N)
  STATUS=$(curl -s -o /tmp/pipeline_resp.json -w "%{http_code}" -X POST http://localhost:3001/p3dx/workloads/run \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"datasetId":"test-dataset-bench-001","applicationId":"bench-app-001"}')
  END=$(date +%s%3N)
  ELAPSED=$((END - START))

  if [ "$STATUS" != "201" ]; then
    echo "WARNING: call $i returned HTTP $STATUS"
  fi

  TIMES+=($ELAPSED)
done

# Print raw times
echo "Raw times (ms): ${TIMES[*]}"
echo ""

# Compute stats with node
echo "${TIMES[*]}" | tr ' ' '\n' | node -e "
const lines = require('fs').readFileSync('/dev/stdin','utf8').trim().split('\n');
const samples = lines.map(Number).filter(x => !isNaN(x) && x > 0);
const s = [...samples].sort((a,b) => a-b);
const mean = s.reduce((a,b) => a+b, 0) / s.length;
const pct = (p) => { const idx = Math.ceil(p/100*s.length)-1; return s[Math.max(0,idx)]; };
console.log('Pipeline E2E latency (n=' + s.length + '):');
console.log('  mean=' + mean.toFixed(1) + 'ms');
console.log('  p50=' + pct(50) + 'ms  p95=' + pct(95) + 'ms  p99=' + pct(99) + 'ms');
console.log('  min=' + s[0] + 'ms  max=' + s[s.length-1] + 'ms');
const throughput = (s.length / (s.reduce((a,b)=>a+b,0)/1000)).toFixed(1);
console.log('  sequential throughput: ~' + throughput + ' req/s');
"
