---
description: Operations runbook for p3dx-aaa anon backend (Keycloak + immuDB + MAA token ingestion)
---

# p3dx-aaa Anon Backend — Ops / Dev Runbook

This document consolidates:

- How to start the backend
- How to start Keycloak
- How to setup/diagnose immuDB
- How to test the backend (including MAA token ingestion)
- How to port-forward services from the VM
- What is stored/audited in immuDB
- Endpoint contract for frontend integration

## 1) Architecture overview

- **Backend**: Node.js (Express)
  - Entry: `src/server.js`
  - App: `src/app.js`
  - Routes mounted under: `/anon` (`src/routes/anon.routes.js`)
- **Auth**: Keycloak (ROPC for login)
  - JWT verification using JWKS (`src/middlewares/auth.middleware.js`)
  - Role enforcement (`src/middlewares/role.middleware.js`)
- **Audit storage**: immuDB
  - Audit trail: `audit:*` keys (via `logAuditEvent`)
  - MAA token mapping: `maa:*` keys (via `storeMaaTokens`)

## 2) Required configuration (.env)

A template exists at `.env.example`. The real `.env` is not committed.

### Keycloak

- `KEYCLOAK_BASE_URL` (example: `http://localhost:8080`)
- `KEYCLOAK_REALM` (example: `master`)
- `KEYCLOAK_ADMIN_USER`, `KEYCLOAK_ADMIN_PASSWORD` (for provisioning users)
- `KEYCLOAK_CLIENT_ID`, `KEYCLOAK_CLIENT_SECRET` (for `/anon/login` token request)

### immuDB

- `IMMUDB_HOST` (example: `127.0.0.1`)
- `IMMUDB_PORT` (example: `3322`)
- `IMMUDB_ADMIN_USER` (default: `immudb`) (used by `npm run setup:immudb` / `npm run diagnose:immudb`)
- `IMMUDB_ADMIN_PASSWORD` (default: `immudb`) (used by `npm run setup:immudb` / `npm run diagnose:immudb`)
- `IMMUDB_USER` (example: `anon_backend`)
- `IMMUDB_PASSWORD` (password for `IMMUDB_USER`)
- `IMMUDB_DATABASE` (example: `anon_audit` or `anon_audit_clean`)

Notes:

- `IMMUDB_ADMIN_*` are only needed for provisioning/diagnostics scripts.
- The running backend (`npm start`) uses `IMMUDB_USER`, `IMMUDB_PASSWORD`, and `IMMUDB_DATABASE`.

### Backend

- `PORT` (default: `3000`)

## 3) CORS

CORS allowlist is configured in `src/app.js`.

Allowed origins (as configured):

- `https://spider.p3dx.iudx.org.in`
- `http://localhost:5173`
- `http://localhost:5174`
- `https://login.p3dx.iudx.org.in`

Allowed headers:

- `Content-Type`
- `Authorization`

Allowed methods:

- `GET`, `POST`, `OPTIONS`

## 4) Start/stop commands

All commands below are run from repo root unless specified.

### Start backend

```bash
npm start
```

- Starts `src/server.js`
- Initializes immuDB (`initImmuDB`) before listening

### Start backend on a different port (useful during testing)

```bash
PORT=3001 node src/server.js
```

This is **temporary** for avoiding port conflicts. Default remains `3000`.

### Development mode

```bash
npm run dev
```

Note: `npm run dev` uses nodemon on `src/server.js`.

## 5) Keycloak commands (VM)

Example Keycloak dev startup (from Keycloak install directory):

```bash
bin/kc.sh start-dev \
  --db=postgres \
  --db-url='jdbc:postgresql://localhost:5432/keycloak' \
  --db-username=keycloak_admin \
  --db-password='<KEYCLOAK_DB_PASSWORD>'
```

- Keycloak serves on `http://localhost:8080` by default.

Quick check:

```bash
curl -I http://localhost:8080
```

## 6) immuDB setup / diagnosis

### Diagnose connectivity/credentials

```bash
npm run diagnose:immudb
```

Purpose:

- Checks whether immuDB is reachable
- Attempts login and database selection
- Attempts a test write

### Setup database + user permissions

```bash
npm run setup:immudb
```

Purpose:

- Creates the target database (if missing)
- Creates the app user (if missing)
- Ensures permissions on the database
- Tests `useDatabase` + read/write

## 7) Port forwarding (from laptop to VM)

General pattern:

```bash
ssh -L <LOCAL_PORT>:localhost:<REMOTE_PORT> azureuser@<VM_IP>
```

### Backend API

```bash
ssh -L 3000:localhost:3000 azureuser@<VM_IP>
```

### Keycloak

```bash
ssh -L 8080:localhost:8080 azureuser@<VM_IP>
```

### immuDB

```bash
ssh -L 3322:localhost:3322 azureuser@<VM_IP>
```

### Multiple forwards in one SSH session

```bash
ssh \
  -L 3000:localhost:3000 \
  -L 8080:localhost:8080 \
  -L 3322:localhost:3322 \
  azureuser@<VM_IP>
```

## 8) Backend endpoints (frontend integration)

All endpoints are under `/anon`.

### `POST /anon/register`

- Body (JSON): `username,email,password,firstName,lastName`
- Creates Keycloak user + assigns realm role `user`

### `POST /anon/login`

- Body (JSON): `username,password`
- Returns Keycloak `access_token`, `refresh_token`, `expires_in`

### `GET /anon/me`

- Header: `Authorization: Bearer <access_token>`
- Requires role `user`

### `POST /anon/maa-tokens` (NEW)

**Purpose:** Spider UI submits one or more MAA tokens; backend re-verifies Keycloak JWT and stores mapping in immuDB.

**Auth:**

- `Authorization: Bearer <Keycloak access token>`

**Body (preferred):** `application/json`

- Single token:

```json
{ "maa_token": "<MAA_JWT>" }
```

- Multiple tokens:

```json
{ "maa_tokens": ["<MAA_JWT_1>", "<MAA_JWT_2>"] }
```

**Body (alternate):** `text/plain`

- Newline/comma/space separated tokens OR a JSON array string.

**Response:**

```json
{ "status": "SUCCESS", "stored": 2, "errors": [] }
```

Note: `errors` field is currently included for debugging.

## 9) What is stored/audited in immuDB

### 9.1 Audit trail events (`audit:*`)

Stored via `logAuditEvent(eventType, subjectId, metadata)`.

Key patterns:

- `audit:<eventId>`
- `audit:type:<eventType>:<eventId>`
- `audit:subject:<subjectId>:<eventId>`
- `audit:time:<timestamp>:<eventId>`

Event types currently emitted:

- `USER_REGISTER_SUCCESS`
- `USER_REGISTER_FAILED`
- `USER_REGISTER_ERROR`
- `USER_LOGIN_SUCCESS`
- `USER_LOGIN_FAILED`
- `USER_PROFILE_ACCESS`
- `JWT_VERIFY_FAILED`
- `MAA_TOKENS_STORED`
- `MAA_TOKENS_STORE_FAILED`
- `MAA_TOKENS_STORE_ERROR`

### 9.2 MAA token mapping records (`maa:*`) (NEW)

Stored via `storeMaaTokens({ keycloakToken, userId, maaTokens, metadata })`.

For **each MAA token**, one record is written with JSON structure:

```json
{
  "event_id": "<uuid>",
  "event_type": "MAA_TOKEN_RECEIVED",
  "user_id": "<keycloak_sub>",
  "session_hash": "<sha256(keycloak_token)>",
  "timestamp": 1700000000000,
  "occurred_at": "2026-03-03T00:00:00.000Z",
  "keycloak_token": "<RAW_KEYCLOAK_JWT>",
  "maa_token": "<RAW_MAA_JWT>",
  "metadata": {
    "ip": "...",
    "userAgent": "...",
    "timestamp": "...",
    "preferredUsername": "..."
  }
}
```

Key patterns:

- `maa:<eventId>`
- `maa:user:<user_id>:<eventId>`
- `maa:session:<session_hash>:<eventId>`
- `maa:time:<timestamp>:<eventId>`

## 10) Automated test commands

### E2E test

```bash
npm run test:e2e
```

### Audit test

```bash
npm run test:immudb
```

### MAA token feature test (NEW)

```bash
npm run test:maa
```

Useful env vars:

- `BASE_URL=http://localhost:3000` (or `3001` if you started backend on 3001)
- `SUBMIT_MODE=json` or `SUBMIT_MODE=text`
- `MAA_TOKENS='t1,t2,t3'`
- `AUTO_REGISTER=true|false`

Example:

```bash
BASE_URL=http://localhost:3001 SUBMIT_MODE=text npm run test:maa
```

## 11) Manual immuDB verification (immuclient)

Start interactive client:

```bash
docker run --rm -it --network host codenotary/immuclient:latest
```

Then inside `immuclient`:

```text
login anon_backend -a 127.0.0.1 -p 3322
use <IMMUDB_DATABASE>
scan audit:
scan maa:
```

- Use the exact DB name from `.env` (e.g. `anon_audit_clean`).

## 12) Troubleshooting

### immuDB shows `UNAVAILABLE: No connection established`

- Ensure container is up:

```bash
sudo docker ps | grep immudb
```

- Re-run:

```bash
npm run diagnose:immudb
npm run setup:immudb
```

### immuDB shows `PERMISSION_DENIED` on database

- Re-run:

```bash
npm run setup:immudb
```

### Test seems to hit wrong backend

- Start backend on different port and point tests to it:

```bash
PORT=3001 node src/server.js
BASE_URL=http://localhost:3001 npm run test:maa
```
