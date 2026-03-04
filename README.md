# p3dx-aaa

## What this repo contains

This repo currently hosts the **Anon backend** (auth API + audit logging).

## Documentation

- `OPS_RUNBOOK.md`
  - Primary day-to-day developer/ops runbook (start/stop, env vars, endpoints, tests)
- `Setup.md`
  - Full end-to-end environment setup guide (VM + Keycloak + PostgreSQL + immuDB)

## Local setup (quick)

- Create a local `.env` file (do not commit it) based on `.env.example`.
- Install dependencies: `npm install`
- Start backend: `npm start` (or `npm run dev`)

## Useful scripts

- `npm start`
- `npm run dev`
- `npm run test:e2e`
- `npm run setup:immudb`
- `npm run diagnose:immudb`