#!/usr/bin/env node
// JWT verification microbench using the same jose+JWKS pattern aaa's middleware uses.
// Fetches a fresh token, warms the JWKS cache, then measures N verifications.

import('jose').then(async (jose) => {
  const { jwtVerify, createRemoteJWKSet } = jose;
  const { webcrypto } = await import('crypto');
  globalThis.crypto = webcrypto;

  const KC_BASE  = 'http://localhost:8080';
  const KC_REALM = 'master';
  const KC_USER  = 'test';
  const KC_PASS  = 'BenchTest@123';
  const KC_CLIENT_ID = 'anon-backend';
  const KC_CLIENT_SECRET = '77WIVE7zmEJQzXLxjtFTcRL3uUthcSKQ';
  const N = 10000;
  const WARMUP = 100;

  // Get token
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: KC_CLIENT_ID,
    client_secret: KC_CLIENT_SECRET,
    username: KC_USER,
    password: KC_PASS,
  });
  const tokRes = await fetch(`${KC_BASE}/realms/${KC_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!tokRes.ok) {
    console.error('Token fetch failed', tokRes.status, await tokRes.text());
    process.exit(1);
  }
  const { access_token: token } = await tokRes.json();
  console.error(`Token fetched (${token.length} chars)`);

  const jwks = createRemoteJWKSet(new URL(`${KC_BASE}/realms/${KC_REALM}/protocol/openid-connect/certs`));

  // Warm the JWKS cache + JIT
  for (let i = 0; i < WARMUP; i++) {
    await jwtVerify(token, jwks);
  }

  function hrMs(t0) {
    return Number(process.hrtime.bigint() - t0) / 1e6;
  }

  console.error(`JWT verify benchmark (n=${N})...`);
  const times = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await jwtVerify(token, jwks);
    times.push(hrMs(t0));
  }

  const s = [...times].sort((a, b) => a - b);
  const p = (pp) => s[Math.min(Math.floor((pp / 100) * s.length), s.length - 1)];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(`RESULT jwt_verification n=${s.length} mean=${mean.toFixed(3)}ms p50=${p(50).toFixed(3)}ms p95=${p(95).toFixed(3)}ms p99=${p(99).toFixed(3)}ms min=${s[0].toFixed(3)}ms max=${s[s.length-1].toFixed(3)}ms`);
});
