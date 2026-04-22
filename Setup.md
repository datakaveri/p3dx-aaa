# p3dx-aaa Auth System — Full Setup & Handover Guide

This document describes the complete end-to-end setup for:

- Keycloak (IdP) running on an Azure VM (Ubuntu 24.04)
- PostgreSQL (Keycloak internal DB) running locally on the VM
- p3dx-aaa auth backend (Node.js/Express) running on the VM
- immuDB (audit ledger) running on the VM (Docker)
- TOP (TEE Orchestrator Protocol) running locally for POC (Go, port 8085)
- Optional: React/Vite frontend running on a developer laptop

It is written so a teammate can reproduce the full environment from scratch.

---

## 0) Architecture (high-level)

```
Browser / Spider UI
  -> HTTPS (443)
nginx (auth.p3dx.iudx.org.in)
  -> GET /  and frontend routes  -> serves p3dx-auth-ui/dist/ (React SPA)
  -> /anon/* and /p3dx/*         -> proxy to p3dx-aaa (port 3001)

p3dx-aaa auth backend (Node.js/Express, VM, port 3001)
  -> Keycloak Admin API + OIDC token endpoint
Keycloak (VM, port 8080)
  -> PostgreSQL (VM local service, port 5432)
```

Workload orchestration (POC):

p3dx-aaa auth backend -> TOP (Go) (VM local, port 8085)
  -> TOP creates contract, consumer-signs + orchestrator-signs it, triggers TEE deploy

Policy storage (optional local dev):

p3dx-aaa auth backend -> APD (Go) (VM local, port 8082)

Audit logging:
p3dx-aaa auth backend -> immuDB (VM, port 3322)

---

## 1) Ports & Access Model

### VM-side ports

- HTTPS (nginx): `443` — public entry point; serves auth UI + proxies API
- SSH: `22`
- Keycloak: `8080` (dev mode typically binds to all interfaces)
- p3dx-aaa auth backend: `3001` (managed by systemd; nginx proxies to this)
- PostgreSQL (Keycloak DB): `5432` (local to VM)
- immuDB: `3322`
- APD (Go, local dev): `8082` (optional; used for policy submissions)
- TOP (Go, local dev): `8085` (optional; contract storage + token verification)

### Recommended access from a developer machine (Mac/Linux)

Use SSH port forwarding; do not expose admin services publicly.

- Keycloak Admin UI:
  - Local `8181` -> VM `localhost:8080`
- immuDB:
  - Local `3322` -> VM `localhost:3322`
- Optional backend:
  - Local `<PORT>` -> VM `localhost:<PORT>`

---

## 2) VM connection

From your laptop:

```bash
ssh azureuser@<VM_PUBLIC_IP>
```

---

## 3) VM preparation (Ubuntu 24.04)

### 3.1 Update packages

```bash
sudo apt update && sudo apt upgrade -y
```

### 3.2 Install Java 17 (Keycloak 26.x requirement)

```bash
sudo apt install openjdk-17-jdk -y
java -version
```

---

## 4) PostgreSQL setup (Keycloak internal database)

### 4.1 Install and start PostgreSQL

```bash
sudo apt install postgresql postgresql-contrib -y
sudo systemctl status postgresql
```

### 4.2 Create Keycloak DB and user

```bash
sudo -u postgres psql
```

Inside `psql`:

```sql
CREATE DATABASE keycloak;
CREATE USER keycloak_admin WITH PASSWORD '<KEYCLOAK_DB_PASSWORD>';
ALTER DATABASE keycloak OWNER TO keycloak_admin;
GRANT ALL PRIVILEGES ON DATABASE keycloak TO keycloak_admin;
```

Exit:

```sql
\q
```

### 4.3 Ensure password auth is enabled

Edit `pg_hba.conf`:

```bash
sudo nano /etc/postgresql/*/main/pg_hba.conf
```

Ensure entries exist:

```text
local   all   all                     scram-sha-256
host    all   all   127.0.0.1/32      scram-sha-256
host    all   all   ::1/128           scram-sha-256
```

Restart:

```bash
sudo systemctl restart postgresql
```

Verify login:

```bash
psql -h localhost -U keycloak_admin -d keycloak
```

---

## 5) Keycloak 26.4.7 installation and run

### 5.1 Download and extract

```bash
cd ~
wget https://github.com/keycloak/keycloak/releases/download/26.4.7/keycloak-26.4.7.tar.gz
tar -xvzf keycloak-26.4.7.tar.gz
cd keycloak-26.4.7
```

### 5.2 Clean Keycloak state (important when redoing setup)

```bash
rm -rf data
rm -rf conf/optimized
```

### 5.3 Start Keycloak in dev mode using PostgreSQL

```bash
bin/kc.sh start-dev \
  --db=postgres \
  --db-url="jdbc:postgresql://localhost:5432/keycloak" \
  --db-username=keycloak_admin \
  --db-password='<KEYCLOAK_DB_PASSWORD>'
```

Expected log hints:

- PostgreSQL JDBC driver
- `Profile dev activated`
- `Listening on: http://<VM_HOST>:8080`

---

## 6) Access Keycloak Admin Console (from your laptop)

SSH port forward:

```bash
ssh -L 8181:localhost:8080 azureuser@<VM_PUBLIC_IP>
```

Open:

- `http://localhost:8181/`
- Admin console: `http://localhost:8181/admin`

### 6.1 Create initial admin user (first run)

Keycloak will prompt you to create the first admin user.

---

## 7) Keycloak realm/client configuration for p3dx-aaa auth backend

### 7.1 Realm

- Realm: `master` (current setup)

### 7.2 Client (backend)

- Client ID: `anon-backend`
- Client type: confidential
- Direct Access Grants: enabled (required for ROPC)
- Client Secret: configured in backend `.env`

### 7.3 Roles

- Realm role: `user`

---

## 8) immuDB setup (audit database)

immuDB runs on the VM via Docker.

### 8.1 Create volume and start immuDB

```bash
sudo docker volume create immudb-data

sudo docker run -d \
  --name immudb \
  -p 3322:3322 \
  -v immudb-data:/var/lib/immudb \
  codenotary/immudb:latest

sudo docker ps | grep immudb
```

### 8.2 Create audit database and user

There are two supported approaches.

#### Approach A (recommended / automated)

From repo root:

```bash
cd ~/p3dx-aaa
npm run setup:immudb
```

This uses the immuDB admin account to:

- Create database `anon_audit`
- Create user `anon_backend`
- Attempt to grant read/write permissions

#### Approach B (manual / via immuadmin)

```bash
sudo docker exec -it immudb immuadmin login immudb
# follow prompts

sudo docker exec -it immudb immuadmin database create anon_audit
sudo docker exec -it immudb immuadmin user create anon_backend readwrite anon_audit
```

---

## 9) p3dx-aaa auth backend setup

### 9.1 Prerequisites

- Node.js v18+
- Keycloak reachable from backend
- immuDB reachable from backend

### 9.2 Install dependencies

```bash
cd ~/p3dx-aaa
npm install
```

### 9.3 Configure environment

Edit `.env` in repo root.

You can start by copying `.env.example` to `.env`.

Key variables:

```env
PORT=3001

KEYCLOAK_BASE_URL=http://localhost:8080
KEYCLOAK_REALM=master
KEYCLOAK_ADMIN_USER=...
KEYCLOAK_ADMIN_PASSWORD=... 
KEYCLOAK_CLIENT_ID=anon-backend
KEYCLOAK_CLIENT_SECRET=...

IMMUDB_HOST=127.0.0.1
IMMUDB_PORT=3322
IMMUDB_ADMIN_USER=immudb
IMMUDB_ADMIN_PASSWORD=immudb
IMMUDB_USER=anon_backend
IMMUDB_PASSWORD=...
IMMUDB_DATABASE=anon_audit

APD_BASE_URL=http://localhost:8082
```

Notes:

- If you access Keycloak from your laptop via SSH tunnel, that affects your laptop’s browser URL, not the backend. The backend on the VM should still use `http://localhost:8080`.

---

## 9.5) APD (Go) local setup (for policy submissions)

This project supports a Phase-0 policy push flow where the UI submits a policy to the backend, and the backend proxies it to APD:

- Backend: `POST /p3dx/policy`
- APD: `POST /api/v1/policy`

### 9.5.1 Go version

APD requires Go `1.22+`.

### 9.5.2 Postgres (APD storage)

APD requires a Postgres database and credentials (example values):

- `DB_USER=apd`
- `DB_PASSWORD=apdpass`
- `DB_NAME=apd`
- `DB_PORT=5432`

Schema must be applied using `schema.sql` in the APD repo.

### 9.5.3 Keys

APD requires EC key material (P-256) for JWT and signing.

Example paths:

- `/home/azureuser/p3dx-apd/keys/jwt_private.pem`
- `/home/azureuser/p3dx-apd/keys/jwt_public.pem`

### 9.5.4 Run APD

All environment variables are stored in `/home/azureuser/p3dx-apd/.env` (already configured — do not commit this file):

```
PORT=8082
DB_HOST=localhost
DB_PORT=5432
DB_USER=apd
DB_PASSWORD=apdpass
DB_NAME=apd
DB_SSLMODE=disable
JWT_PRIVATE_KEY_PATH=/home/azureuser/p3dx-apd/keys/jwt_private.pem
JWT_PUBLIC_KEY_PATH=/home/azureuser/p3dx-apd/keys/jwt_public.pem
JWT_ISSUER=http://localhost:8082
TEE_ORCHESTRATOR_URL=http://localhost:9999
APD_BASE_URL=http://localhost:8082
APD_SIGNING_KEY_PATH=/home/azureuser/p3dx-apd/keys/jwt_private.pem
APD_POLICY_DUMP_DIR=/home/azureuser/p3dx-apd/policies
```

Build and run manually:

```bash
cd ~/p3dx-apd
go build -o /tmp/p3dx-apd ./cmd/server/main.go
set -a && source .env && set +a
/tmp/p3dx-apd
```

Or use the platform startup script (recommended — starts all services at once):

```bash
~/start-p3dx.sh
```

Expected:

- `APD server listening on :8082`

Policy dump behavior (POC):

- If `APD_POLICY_DUMP_DIR` is set, every `POST /api/v1/policy` will create a new file:
  - `<policyId>_<timestamp>.json`
- This is best-effort and does not fail the request if file write fails.

### 9.5.5 Verify APD

```bash
curl -s http://localhost:8082/health
```

---

## 9.6) nginx setup (serves auth UI + proxies API)

nginx is the public entry point for `https://auth.p3dx.iudx.org.in`. It serves two things:

- **Auth UI** (`p3dx-auth-ui/dist/`) — the React SPA for all non-API paths
- **API proxy** — forwards `/anon/*` and `/p3dx/*` to the backend on port 3001

### 9.6.1 nginx config location

```
/etc/nginx/sites-available/auth.p3dx.iudx.org.in
/etc/nginx/sites-enabled/auth.p3dx.iudx.org.in  (symlink)
```

### 9.6.2 Config structure

```nginx
server {
    listen 443 ssl;
    server_name auth.p3dx.iudx.org.in;
    # ... SSL certs ...

    # Static assets (long cache — Vite adds content hash to filenames)
    location /assets/ {
        root /home/azureuser/p3dx-auth-ui/dist;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # API routes → backend (port 3001)
    location /anon/ { proxy_pass http://127.0.0.1:3001; ... }
    location /p3dx/ { proxy_pass http://127.0.0.1:3001; ... }

    # SPA catch-all: serve index.html for all other GET paths
    location / {
        root /home/azureuser/p3dx-auth-ui/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

### 9.6.3 How GET /p3dx/login works

When Spider logs the user out it redirects the browser to `https://auth.p3dx.iudx.org.in/p3dx/login`:

1. nginx matches `/p3dx/` → proxies to backend
2. Backend `GET /login` handler returns `302 → /login`
3. Browser follows redirect to `https://auth.p3dx.iudx.org.in/login`
4. nginx: `/login` does not match `/anon/` or `/p3dx/` → serves `dist/index.html`
5. React Router sees `/login` → renders Login page ✓

### 9.6.4 Reload nginx after config changes

```bash
sudo nginx -t          # test config first
sudo systemctl reload nginx
```

---

## 9.7) Auth UI deployment (p3dx-auth-ui)

The React auth UI is built to `p3dx-auth-ui/dist/` and served by nginx as a static SPA.

### 9.7.1 Production environment file

`/home/azureuser/p3dx-auth-ui/.env.production`:

```env
VITE_BACKEND_URL=https://auth.p3dx.iudx.org.in
VITE_APP_URL=https://auth.p3dx.iudx.org.in
```

This ensures the login form POSTs to `https://auth.p3dx.iudx.org.in/p3dx/login` (not localhost).

### 9.7.2 Build and deploy

```bash
cd ~/p3dx-auth-ui
npm install         # if node_modules is missing
npm run build       # outputs to dist/
```

nginx serves the new `dist/` immediately — no nginx restart needed after a rebuild.

### 9.7.3 Directory permissions

nginx runs as `www-data`. The home directory and dist folder must be traversable:

```bash
chmod o+x /home/azureuser
chmod o+x /home/azureuser/p3dx-auth-ui
chmod o+x /home/azureuser/p3dx-auth-ui/dist
```

These only need to be set once.

---

## 12.6) Policy submission verification (APD)

After submitting a policy via the UI, use the `policyId` to confirm APD stored it:

```bash
curl -s http://localhost:8082/api/v1/policy/<policyId>
```

### 9.4 Start the backend

```bash
npm start
```

Expected output:

- `✓ immuDB connected and database selected`
- `p3dx-aaa auth backend running on port 3001`

Development mode:

```bash
npm run dev
```

---

## 10) API endpoints

Base URL: `http://<vm>:<PORT>` (or `http://localhost:<PORT>` if port-forwarded)

### 10.1 Auth endpoints

- `GET  /p3dx/login` — browser redirect to `/login` (the React login page); used when Spider logs out
- `POST /p3dx/login` — authenticate with username + password; returns `access_token`, `refresh_token`, `expires_in`
- `POST /p3dx/register`
- `GET  /p3dx/me` (protected; requires Bearer token + role `user`)

`/anon/*` is a full alias for `/p3dx/*` (both paths are mounted on the same route handlers). Spider uses `POST /anon/login` for its login API calls; both work identically.

### 10.2 P3DX endpoints (role requests + policies)

Base path: `/p3dx`

#### `POST /p3dx/policy`

- **Purpose**
  - UI submits an access policy; backend forwards it to APD.
- **Auth**
  - `Authorization: Bearer <Keycloak access token>`
  - Requires Keycloak realm role: `data-provider`
- **Backend config**
  - `APD_BASE_URL` must be set (example: `http://localhost:8082`)
- **Body (JSON)**
  - Must match APD `ReceivePolicyBody`:

```json
{
  "policyId": "policy-<uuid>",
  "itemId": "ds-001",
  "issuedBy": "<username>",
  "rules": { "any": "json" },
  "expiresAt": "2026-03-14T00:00:00.000Z"
}
```

Notes:

- `expiresAt` is optional.
- `rules` is free-form JSON; APD stores it as-is.

#### `POST /p3dx/maa-tokens`

- **Purpose**
  - UI submits one or more MAA tokens; backend verifies the Keycloak JWT and stores mappings in immuDB.
- **Auth**
  - `Authorization: Bearer <Keycloak access token>`
- **Body (preferred)**: `application/json`

Single token:

```json
{ "maa_token": "<MAA_JWT>" }
```

Multiple tokens:

```json
{ "maa_tokens": ["<MAA_JWT_1>", "<MAA_JWT_2>"] }
```

- **Body (alternate)**: `text/plain`
  - Newline/comma/space separated tokens OR a JSON array string.

---

## 11) Audit logging behavior (immuDB)

Audit events are written to immuDB under multiple keys:

- Primary event key:
  - `audit:<event_id>`
- Index by type:
  - `audit:type:<event_type>:<event_id>`
- Index by subject:
  - `audit:subject:<subject_id>:<event_id>`
- Index by time:
  - `audit:time:<timestamp>:<event_id>`

Event types logged:

- `USER_REGISTER_SUCCESS`
- `USER_REGISTER_FAILED`
- `USER_REGISTER_ERROR`
- `USER_LOGIN_SUCCESS`
- `USER_LOGIN_FAILED`
- `USER_PROFILE_ACCESS`
- `JWT_VERIFY_FAILED`

---

## 12) Verification / test commands

All commands run from the repo root (`~/p3dx-aaa`).

### 12.1 Diagnose immuDB connectivity

```bash
npm run diagnose:immudb
```

### 12.2 End-to-end auth test (register → login → profile)

```bash
npm run test:e2e
```

### 12.3 Workload contract test

Requires a running backend (and optionally TOP + APD for full flow).

```bash
npm run test:workload
```

Env overrides: `DATASET_ID`, `APPLICATION_ID`, `TEST_USERNAME`, `TEST_PASSWORD`.

### 12.4 Policy submission test

Requires a user with the `data-provider` role and APD running.

```bash
TEST_DP_USERNAME=<user> TEST_DP_PASSWORD=<pass> npm run test:policy
```

### 12.5 Role request workflow test

Requires an admin account.

```bash
TEST_ADMIN_USERNAME=<admin> TEST_ADMIN_PASSWORD=<pass> npm run test:role-requests
```

### 12.6 MAA token submission test

```bash
npm run test:maa
```

### 12.7 Full immuDB audit test suite

```bash
npm run test:immudb
```

### 12.8 Print audit events

```bash
npm run test:audit
```

---

## 12.5) What each remaining script/file is for (and how to use it)

This repo was intentionally cleaned down to only:

- The runtime backend (`src/`)
- A minimal set of operational scripts that help a new teammate:
  - Provision immuDB (once)
  - Diagnose connectivity
  - Prove the system works end-to-end
  - Inspect audit logs

### `setup-immudb.mjs` (provisioning)

- **Purpose**
  - Creates (or verifies) the immuDB database `anon_audit`
  - Creates (or verifies) the application user `anon_backend`
  - Validates the user can select the database
- **When to use**
  - First time setting up immuDB on a fresh VM/container/volume
  - After you reset immuDB data / redeploy immuDB
- **How to run**

```bash
cd ~/p3dx-aaa
npm run setup:immudb
```

### `diagnose-immudb.mjs` (connectivity check)

- **Purpose**
  - Tests immuDB login and database selection with common credential sets
  - Quickly tells you whether immuDB is reachable and whether the configured user works
- **When to use**
  - If backend prints immuDB connection warnings
  - If audit events are not appearing in immuDB
- **How to run**

```bash
cd ~/p3dx-aaa
npm run diagnose:immudb
```

### `test-e2e.js` (API-only E2E)

- **Purpose**
  - Exercises the backend auth API flow end-to-end (Keycloak + backend routes)
  - Useful for quickly validating that Keycloak config + backend config are correct
- **When to use**
  - After changing Keycloak realm/client settings
  - After changing backend Keycloak env vars
- **How to run**

```bash
cd ~/p3dx-aaa
npm run test:e2e
```

### `test-immudb-audit.js` (full audit E2E)

- **Purpose**
  - Runs a complete flow that should generate audit events
  - Connects to immuDB, performs register/login/me calls, then reads back audit keys from immuDB
- **When to use**
  - After provisioning immuDB
  - After changing audit logging code
  - To prove that events are persisted (not just printed)
- **How to run**

```bash
cd ~/p3dx-aaa
npm run test:immudb
```

### `verify-audit.js` (human-readable audit viewer)

- **Purpose**
  - Prints stored audit events in a readable format (connects directly to immuDB)
  - This is the simplest way for a human to confirm auditing is working
- **When to use**
  - Any time you want to check what events are stored
  - After manual curl testing
- **How to run**

```bash
cd ~/p3dx-aaa
npm run test:audit
```

> **Note:** `view-audit.js` is an older variant of the same audit viewer kept for reference; prefer `verify-audit.js` via `npm run test:audit`.

### `test-workload.js` (workload contract E2E)

- **Purpose**
  - Registers a test user (or reuses `TEST_USERNAME`/`TEST_PASSWORD`), runs a workload via `POST /p3dx/workloads/run`, verifies the returned signed contract has both consumer and orchestrator signatures, confirms the immuDB audit record is stored, and optionally verifies the `/result` endpoint
  - Proves the full contract pipeline — TOP contract creation, consumer + orchestrator signing, immuDB persistence — works end-to-end
- **When to use**
  - After changing the TOP `/workload` handler or contract creation logic
  - After changing TOP integration env vars (`TOP_BASE_URL`, `CONTRACT_SERVER_SECRET`)
  - After updating `catalogueData.js` dataset/application IDs
- **How to run**

```bash
cd ~/p3dx-aaa
# Minimal — auto-registers a fresh user
npm run test:workload

# Use existing credentials and override dataset/app
BASE_URL=http://localhost:3001 \
TEST_USERNAME=alice TEST_PASSWORD=secret \
DATASET_ID=ds-001 APPLICATION_ID=app-1 \
npm run test:workload
```

### `test-policy.js` (data-provider policy submission)

- **Purpose**
  - Logs in as a `data-provider` user, verifies the role via `/p3dx/me`, and submits a dataset access policy via `POST /p3dx/policy` (which the backend proxies to APD)
  - Exits successfully (code 0) if APD is not running; only fails on auth or backend errors
- **When to use**
  - After changing the policy proxy route or APD config (`APD_BASE_URL`)
  - To confirm a `data-provider` account is correctly set up in Keycloak
- **How to run**

```bash
cd ~/p3dx-aaa
TEST_DP_USERNAME=<data-provider-user> TEST_DP_PASSWORD=<pass> npm run test:policy
```

### `test-role-requests.js` (role request workflow)

- **Purpose**
  - Auto-registers a new user, requests the `data-provider` role, verifies it appears in "my requests", then logs in as admin and approves it, and re-logs in as the user to confirm the role was granted
  - Exercises the full role request lifecycle: creation → admin list → approval → role reflected in token
- **When to use**
  - After changing role request routes or Keycloak role-assignment logic
  - To verify an admin account has the `admin` realm role
- **How to run**

```bash
cd ~/p3dx-aaa
TEST_ADMIN_USERNAME=<admin-user> TEST_ADMIN_PASSWORD=<pass> npm run test:role-requests
```

### `test-maa-tokens.js` (MAA token storage)

- **Purpose**
  - Logs in as a `user` and POSTs a mock MAA attestation token payload to `POST /p3dx/maa-tokens`
  - Verifies the endpoint accepts the token and logs the audit event
- **When to use**
  - After changing the MAA token route
  - During TEE attestation integration testing
- **How to run**

```bash
cd ~/p3dx-aaa
npm run test:maa
```

### `src/` (the backend)

- **Purpose**
  - Implements the Express server + Keycloak integration + immuDB audit logging
- **How to start**

Run these commands from the backend repo root (`~/p3dx-aaa`).

```bash
cd ~/p3dx-aaa
npm start
```

### `package.json` scripts (what they mean)

- **`npm start`**
  - Runs `node src/server.js`
- **`npm run dev`**
  - Runs `nodemon src/server.js` (auto-reload during development)
- **`npm run setup:immudb`**
  - Runs `node setup-immudb.mjs`
- **`npm run diagnose:immudb`**
  - Runs `node diagnose-immudb.mjs`
- **`npm run test:e2e`**
  - Runs `node test-e2e.js`
- **`npm run test:immudb`**
  - Runs `node test-immudb-audit.js`
- **`npm run test:audit`**
  - Runs `node verify-audit.js`
- **`npm run test:workload`**
  - Runs `node test-workload.js` — workload contract E2E (register → run → retrieve → optional result)
- **`npm run test:policy`**
  - Runs `node test-policy.js` — data-provider policy submission (requires `TEST_DP_USERNAME`/`TEST_DP_PASSWORD`)
- **`npm run test:role-requests`**
  - Runs `node test-role-requests.js` — full role request lifecycle (requires `TEST_ADMIN_USERNAME`/`TEST_ADMIN_PASSWORD`)
- **`npm run test:maa`**
  - Runs `node test-maa-tokens.js` — MAA attestation token submission

---

## 12.5 Workload contract (Run Workload)

When a user clicks “Run Workload” in the UI, p3dx-aaa forwards the raw workload parameters to TOP. TOP owns the full contract lifecycle: it creates the contract, produces the consumer HMAC signature, validates the dataset policy with APD, signs with the orchestrator key, stores the signed contract to disk, and triggers TEE deployment. p3dx-aaa receives the fully signed contract back in TOP's response, stores it in immuDB, and returns it to the UI.

### API endpoints

- `POST /p3dx/workloads/run`
  - **Auth**: requires Keycloak JWT (`Authorization: Bearer ...`) and `user` role
  - **Body**: `{ “datasetId”: “...”, “applicationId”: “...” }`
  - **Response**: `{ status: “SUCCESS”, contract_id: “...”, contract: { ... }, top: { ... } }`
    - `contract` is the fully signed contract (consumer + orchestrator signatures present) returned by TOP.
    - `contract` is `null` if TOP is disabled or unreachable.
  - **Behavior**
    - Forwards `{ access_token, dataset_id, application_id }` to TOP (`POST ${TOP_BASE_URL}/workload`).
    - TOP creates and signs the contract (see TOP pipeline below).
    - Stores the returned signed contract once in immuDB.
- `GET /p3dx/workloads/contracts/:contractId/result`
  - **Auth**: Bearer JWT (user)
  - **Response**: `{ status: “SUCCESS”, tee_status: “STARTED”, contract_id: “...”, app_id: “...”, signed_contract: { ... } }`
  - **Behavior**: Fetches the stored signed contract from TOP (`GET ${TOP_BASE_URL}/contracts/:contractId`) and returns it to the UI.
- `GET /p3dx/workloads/contracts/:contractId`
  - **Auth**: requires Keycloak JWT and `user` role
  - **Response**: `{ status: “SUCCESS”, record: { ... } }` — retrieves the contract audit record from immuDB.

### TOP pipeline (POST /workload)

When TOP receives `{ access_token, dataset_id, application_id }` it runs these steps:

1. Decode JWT claims from `access_token` (`sub`, `sid`, `iat`, `exp`)
2. Build contract struct — UUID `contract_id`, 90-day lifecycle, parties, dataset/app terms
3. Compute consumer HMAC-SHA256 signature using `CONTRACT_SERVER_SECRET`
4. Fetch dataset policy from APD — `GET ${APD_BASE_URL}/api/v1/policy/by-item/:datasetId` — reject if missing
5. Store unsigned contract (AES-256-GCM encrypted `.bin` + plain `.json`)
6. Sign with orchestrator RSA private key (PKCS1v15-SHA256); embed in `contract.signatures.orchestrator_signature`
7. Overwrite stored contract with signed version
8. Fetch docker-compose URL from backend — `GET ${BACKEND_URL}/p3dx/apps/:appId/compose-url` (X-API-Key)
9. Call DeployEnclave (dry-run by default)
10. Return `{ status: “success”, contract_id: “...”, contract: { ... } }`

### Required env vars

**p3dx-aaa `.env`:**

- `TOP_ENABLED=true`
- `TOP_BASE_URL` (example: `http://localhost:8085`)
- `TOP_AUTH_MODE=bearer`
- `TOP_REQUIRED=true` — fail `POST /p3dx/workloads/run` if TOP submission fails

**TOP `.env`:**

- `CONTRACT_SERVER_SECRET` — HMAC secret for consumer signing (must be set in TOP, not p3dx-aaa)
- `BACKEND_URL` — p3dx-aaa base URL (for compose-url callback)
- `BACKEND_API_KEY` — shared key for TOP→backend callbacks
- `APD_BASE_URL` — APD base URL (for policy fetch)
- `ORCH_PRIVATE_KEY_PATH` — path to orchestrator RSA private key (falls back to mock if absent)

TOP runtime configuration (POC):

- TOP is a separate Go project (in this workspace under `~/Top`).
- `TEE_DEPLOY_DRY_RUN=true` (default) — skips the actual enclave deploy HTTP call.
- TOP loads environment from a local `.env` file via `godotenv.Load()` in `Top/main.go`.

Create `~/Top/.env` (do not commit secrets):

```env
PORT=8085

# Backend base URL reachable from TOP
BACKEND_URL=http://localhost:3001

# Must match backend TOP_BACKEND_API_KEY
BACKEND_API_KEY=<same value as TOP_BACKEND_API_KEY>

# APD base URL reachable from TOP (used to fetch policy by datasetId)
APD_BASE_URL=http://localhost:8082

# Optional: orchestrator signing key (RSA private key path). If not set, TOP uses a mock signature.
ORCH_PRIVATE_KEY_PATH=/path/to/orchestrator_private_key.pem
```

Run TOP:

```bash
cd ~/Top
go build -o /tmp/top-server .
/tmp/top-server
```

TOP loads its `.env` automatically on startup (via `godotenv.Load()`). Or use the platform startup script (recommended):

```bash
~/start-p3dx.sh
```

Strict behavior:

- If TOP cannot reach backend token verification endpoint or `match=false`, TOP rejects contract ingestion.
- If backend has `TOP_REQUIRED=true`, then `POST /p3dx/workloads/run` fails with `502 TOP_SUBMISSION_FAILED`.

Policy fetch from APD (POC):

- After token verification succeeds, TOP extracts `datasetId` from the contract:
  - `contract.data_provider_terms.data_resource_id`
- TOP attempts to fetch policy by dataset id (APD `itemId`) from:
  - `GET ${APD_BASE_URL}/api/v1/policy/by-item/{itemId}`
- Current behavior (matches implementation):
  - `200` -> proceeds
  - `404` -> TOP rejects contract ingestion (blocks the flow)
  - Any other non-2xx -> TOP rejects contract ingestion (blocks the flow)

Orchestrator/system-side contract signature (POC):

- After the APD fetch step, TOP signs the contract (system-side signing) and embeds the result in the contract before storing it.
- Added fields in the stored contract JSON under `signatures`:
  - `orchestrator_signature` (base64)
  - `orchestrator_signature_algorithm` (`RSA_PKCS1V15_SHA256`)
  - `signed_at.orchestrator` (RFC3339 timestamp)

TEE deployment trigger (POC):

- After TOP stores the signed contract, TOP extracts `app_id` from:
  - `contract.application_provider_terms.app_id`
- TOP calls backend to resolve the docker-compose reference (by `app_id`) via:
  - `GET /p3dx/apps/{appId}/compose-url`
  - Header: `X-API-Key: <TOP_BACKEND_API_KEY>`
  - Response: `{ status: "SUCCESS", app_id: "app-1", compose_url: "https://...yaml" }`
- TOP passes the resolved `compose_url` to `DeployEnclave` as part of the deploy request payload.
- On successful deploy, TOP logs: `TEE started`.

TEE deploy dry-run mode (POC):

- Since the deploy API may not be hosted yet, TOP defaults to a dry-run mode where it will *not* make an outbound HTTP call.
- Control this with:
  - `TEE_DEPLOY_DRY_RUN=true` (default if unset): skip HTTP call, still proceed and log `TEE started`.
  - `TEE_DEPLOY_DRY_RUN=false`: perform the real HTTP call to `TEE_DEPLOY_URL` (or fallback URL).

Workload result page (UI) (POC):

- After a successful `POST /p3dx/workloads/run`, the UI navigates to:
  - `/app/services/run/:contractId`
- The page calls:
  - `GET /p3dx/workloads/contracts/:contractId/result`
- The page displays:
  - `TEE started`
  - The final signed contract JSON (consumer + orchestrator signatures).

TOP contract retrieval endpoint (POC):

- TOP exposes a read-only endpoint to return the stored signed contract JSON:
  - `GET /contracts/:contractId`
- This reads `${STORE_PATH}/${contractId}.json` (TOP writes this file while processing `/contract`).
- Note: this endpoint is currently unauthenticated (POC) and is intended to be reachable only on trusted/local network.

Required env vars for result flow (POC):

- Backend (`p3dx-aaa`)
  - `TOP_BASE_URL` must point to TOP, e.g. `http://localhost:8085`.
  - Used by `GET /p3dx/workloads/contracts/:contractId/result` to fetch `GET ${TOP_BASE_URL}/contracts/:contractId`.
- TOP
  - `STORE_PATH` should be the directory where TOP writes `{contractId}.json`.
  - `STORE_KEY` should be a 32-byte string (TOP falls back to a dummy key if invalid).

TEE deploy configuration (TOP) (POC):

- `TEE_DEPLOY_DRY_RUN=true` (default if unset)
  - `DeployEnclave()` does not make an HTTP request and returns success.
- `TEE_DEPLOY_DRY_RUN=false`
  - `DeployEnclave()` makes an HTTP request to:
    - `TEE_DEPLOY_URL` (preferred), or
    - `ENCLAVE_DEPLOY_URL` (fallback), or
    - `http://localhost:8080/deployEnclave` (default).

Backend compose URL mapping (POC):

- Backend stores the `app_id -> compose_url` mapping in:
  - `src/config/compose-urls.json`
- Example format:

```json
{
  "compose_urls": {
    "app-1": "https://raw.githubusercontent.com/prathmeshj1729/Docker-Compose/refs/heads/main/docker-compose-skald.yaml",
    "app-2": "https://raw.githubusercontent.com/prathmeshj1729/Docker-Compose/refs/heads/main/docker-compose-dp.yaml"
  }
}
```

## 12.6 End-to-end flow (narrative, POC)

This proof-of-concept has four main runtime components:

The **Auth UI** (`p3dx-auth-ui`) is the user-facing dashboard where a consumer triggers “Run Workload” and later views the workload result (TEE started + final signed contract).

The **Auth Backend** (`p3dx-aaa`) is the central API gateway for the UI. It handles user authentication (Keycloak JWT), forwards workload requests to TOP, writes the returned signed contract to immuDB as an immutable audit record, and serves the result to the UI.

The **Trusted Orchestrator Platform (TOP)** (`~/Top`) now owns the full contract lifecycle. It receives the raw workload parameters from p3dx-aaa, creates the contract struct, produces the consumer HMAC signature, fetches the dataset policy from APD, signs the contract with the orchestrator RSA key, persists the signed contract to disk, resolves the docker-compose reference for the application via the backend, and triggers TEE deployment (dry-run by default).

The **APD** (`p3dx-apd`) is the policy service. A data-provider submits a policy into APD, and TOP fetches that policy by dataset id (`itemId`) before it accepts a contract. For POC resiliency, APD dumps received policies to disk and will reload policies from the dump directory on-demand when `/by-item/{itemId}` is called.

### Run Workload: step-by-step execution

1) The consumer signs in to Keycloak via the UI. The UI stores the access token in `localStorage`.

2) The consumer opens **Services → Run Workload**, selects a dataset and application, and clicks **Run Workload**.

3) The UI calls the backend `POST /p3dx/workloads/run` with the user JWT (Bearer token) and the selected `{ datasetId, applicationId }`.

4) p3dx-aaa verifies the JWT and role, then forwards `{ access_token, dataset_id, application_id }` to TOP (`POST ${TOP_BASE_URL}/workload`).

5) TOP decodes the JWT claims (`sub`, `sid`, `iat`, `exp`) from `access_token` and builds the contract struct — generating a UUID `contract_id`, 90-day lifecycle, all party and terms fields.

6) TOP computes the consumer HMAC-SHA256 signature using `CONTRACT_SERVER_SECRET` and embeds it in `contract.signatures.consumer_signature`.

7) TOP fetches the dataset access policy from APD (`GET ${APD_BASE_URL}/api/v1/policy/by-item/{datasetId}`). If the policy is missing or APD fails, TOP rejects the contract.

8) TOP stores the unsigned contract to disk (AES-256-GCM encrypted `.bin` and plain `.json`).

9) TOP signs the contract with the orchestrator RSA private key (PKCS1v15-SHA256) and embeds the signature in `contract.signatures.orchestrator_signature`. The signed contract overwrites the disk files.

10) TOP fetches the docker-compose URL from the backend (`GET ${BACKEND_URL}/p3dx/apps/{appId}/compose-url`, `X-API-Key` protected) to resolve the application’s enclave descriptor.

11) TOP calls `DeployEnclave()` with the signed contract and compose URL. `TEE_DEPLOY_DRY_RUN=true` (default) skips the actual HTTP call while still logging `TEE started`.

12) TOP returns `{ status: “success”, contract_id: “...”, contract: { ... } }` — the fully signed contract is in the response body.

13) p3dx-aaa receives the signed contract, writes it to immuDB (`workload-contract:<contractId>`), and returns `{ status: “SUCCESS”, contract_id, contract, top }` to the UI.

14) The UI navigates to `/app/services/run/:contractId`. The Workload Result page calls `GET /p3dx/workloads/contracts/:contractId/result`, which fetches the stored contract from TOP and returns it for display.

---

## 13) Viewing audit logs with immuclient

### 13.1 On the VM (Linux)

Run immuclient with host networking:

```bash
docker run --rm -it --network host codenotary/immuclient:latest
```

Inside immuclient:

```text
login anon_backend -a 127.0.0.1 -p 3322
# enter password when prompted

use anon_audit
scan audit:
```

Important:

- Use `scan audit:` (no quotes). `scan "audit:"` may return no entries depending on immuclient version.

### 13.2 From a Mac (recommended: SSH tunnel)

Create the tunnel:

```bash
ssh -L 3322:localhost:3322 azureuser@<VM_PUBLIC_IP>
```

Then run immuclient locally:

```bash
docker run --rm -it codenotary/immuclient:latest
```

Inside:

```text
login anon_backend -a 127.0.0.1 -p 3322
use anon_audit
scan audit:
```

---

## 14) Operational notes / troubleshooting

### 14.1 Backend starts but immuDB is “console-only”

- Verify immuDB is running: `docker ps | grep immudb`
- Verify credentials: `npm run diagnose:immudb`
- Re-run setup: `npm run setup:immudb`

### 14.2 Login returns 401

- Confirm user exists in Keycloak
- Confirm client `anon-backend` has Direct Access Grants enabled
- Confirm backend `.env` has correct client secret

### 14.4 Run Workload returns 502 TOP_SUBMISSION_FAILED

This means backend could not successfully submit the contract to TOP, and `TOP_REQUIRED=true` is enabled.

Checklist:

- Ensure TOP is running and listening on `TOP_BASE_URL`.
- Ensure TOP has `BACKEND_URL` and `BACKEND_API_KEY` set (usually via `~/Top/.env`).
- Ensure backend `.env` has `TOP_BACKEND_API_KEY` set and backend service was restarted after `.env` changes.
- If you are debugging, temporarily set `TOP_REQUIRED=false` to allow the request to succeed while still returning `top.status`/`top.data`.

### 14.5 Anonymization service tile redirects to Spider UI (SSO handoff)

In `p3dx-auth-ui`, the Anonymization tile redirects the user to Spider and passes Keycloak tokens via URL hash:

- Redirect target: `https://spider.p3dx.iudx.org.in/#access_token=...&refresh_token=...&expires_in=...`
- Tokens are read from `localStorage` keys:
  - `access_token`
  - `refresh_token`
  - `expires_in`

**Spider logout redirect (important):**

When Spider logs out, it must redirect the user to `https://auth.p3dx.iudx.org.in/p3dx/login` so they land on our custom login page (not Keycloak's built-in login page). This URL must be configured in the Spider UI's settings or in Keycloak admin under the `anon-backend` client's **Valid post logout redirect URIs**. If this is not set, Spider will redirect to the Keycloak login page at `https://login.p3dx.iudx.org.in/` instead.

### 14.3 Keycloak admin UI not accessible

- Ensure Keycloak is running on VM: check its logs
- Ensure SSH port forward is active: `ssh -L 8181:localhost:8080 ...`

---

## 15) Start/Stop summary (commands)

### Start PostgreSQL

```bash
sudo systemctl start postgresql
```

### Start Keycloak

```bash
cd ~/keycloak-26.4.7
bin/kc.sh start-dev \
  --db=postgres \
  --db-url="jdbc:postgresql://localhost:5432/keycloak" \
  --db-username=keycloak_admin \
  --db-password='<KEYCLOAK_DB_PASSWORD>'
```

### Start immuDB

```bash
/snap/bin/docker start immudb
```

### Start nginx

```bash
sudo systemctl start nginx
```

### Start backend (p3dx-aaa, port 3001)

The backend is managed by systemd. nginx proxies `/anon/*` and `/p3dx/*` to this service.

```bash
sudo systemctl start p3dx-aaa-auth-backend.service
```

Check status:

```bash
sudo systemctl status p3dx-aaa-auth-backend.service
```

---

## 16) Security / handover notes

- Credentials in this document are current working values; rotate them for production.
- Avoid exposing Keycloak/immuDB publicly; use SSH forwarding for admin access.
- Consider storing secrets in a secrets manager for production.

---

## 17) Optional: run components with systemd (.service units)

If you are repeatedly starting/stopping services on the VM, you can use systemd unit files.

This repo provides templates under `systemd/`:

- `systemd/keycloak-dev.service`
- `systemd/immudb-container.service`
- `systemd/p3dx-aaa-auth-backend.service`

These units deliberately do **not** embed secrets. They reference local `EnvironmentFile=` paths.

Notes:

- This VM uses Docker installed via snap, so the Docker daemon service is `snap.docker.dockerd.service` and the Docker CLI is typically `/snap/bin/docker`.
- `immudb-container.service` intentionally wraps Docker commands using `/bin/bash -lc` (systemd does not interpret pipes like `|` unless run through a shell).

### 17.1 Install unit files

> **After merging to main:** The unit file `systemd/p3dx-aaa-auth-backend.service` references `WorkingDirectory`, `EnvironmentFile`, and `ExecStart` paths. Ensure these point to `~/p3dx-aaa` (not a working-copy directory) before installing.

Copy the unit files into systemd:

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
```

### 17.2 Create Keycloak environment file

Create `/etc/p3dx-aaa/keycloak.env` (do not commit; restrict permissions):

```bash
sudo mkdir -p /etc/p3dx-aaa
sudo nano /etc/p3dx-aaa/keycloak.env
sudo chmod 600 /etc/p3dx-aaa/keycloak.env
```

Example keys (fill values locally):

```bash
KC_DB_URL=jdbc:postgresql://localhost:5432/keycloak
KC_DB_USERNAME=keycloak_admin
KC_DB_PASSWORD=<KEYCLOAK_DB_PASSWORD>
```

### 17.3 Enable and start

#### Single-command startup (recommended)

The `start-p3dx.sh` script in the home directory starts the entire platform — systemd services, p3dx-apd, TOP, and auth-ui — in one command:

```bash
~/start-p3dx.sh   # start everything
~/stop-p3dx.sh    # stop everything
```

It builds the Go binaries fresh each run, sources `.env` files, starts background processes, and saves PIDs to `/tmp/p3dx-pids`. Logs go to `/tmp/p3dx-apd.log`, `/tmp/p3dx-top.log`, `/tmp/p3dx-ui.log`.

#### Watch logs
tail -f /tmp/p3dx-apd.log /tmp/p3dx-top.log /tmp/p3dx-ui.log   # watch all logs

#### Manual systemd commands

Enable and start on boot:

```bash
sudo systemctl enable --now immudb-container.service
sudo systemctl enable --now keycloak-dev.service
sudo systemctl enable --now p3dx-aaa-auth-backend.service
```

Start (without enabling on boot):

```bash
sudo systemctl start immudb-container.service
sudo systemctl start keycloak-dev.service
sudo systemctl start p3dx-aaa-auth-backend.service
```

Stop (keeps enabled for next boot):

```bash
sudo systemctl stop p3dx-aaa-auth-backend.service
sudo systemctl stop keycloak-dev.service
sudo systemctl stop immudb-container.service
```

Disable and stop (won't start on boot):

```bash
sudo systemctl disable --now p3dx-aaa-auth-backend.service
sudo systemctl disable --now keycloak-dev.service
sudo systemctl disable --now immudb-container.service
```

Check status/logs:

```bash
sudo systemctl status p3dx-aaa-auth-backend.service
sudo journalctl -u p3dx-aaa-auth-backend.service -f
```

---

## 18) Checking services from a macOS laptop (SSH port forwarding)

If you want to access Keycloak and the backend from your laptop without exposing VM ports publicly, use SSH port forwarding.

### 18.1 SSH config (recommended)

Add a host entry to `~/.ssh/config` on your Mac:

```sshconfig
Host p3dx-auth-vm
  HostName <VM_PUBLIC_IP>
  User azureuser

  ServerAliveInterval 30
  ServerAliveCountMax 3

  LocalForward 8181 localhost:8080
  LocalForward 3001 localhost:3001
  LocalForward 3322 localhost:3322
```

### 18.2 Start the tunnel (auto-reconnect)

Install `autossh` on macOS (Homebrew) and run:

```bash
autossh -M 0 -N p3dx-auth-vm
```

Notes:

- If you already have an IDE-managed SSH session (Remote SSH / port forwarding), the local ports may already be bound (8181/3001/3322). In that case, you can use the forwarded ports directly and you do not need `autossh`.
- If your `~/.ssh/config` includes `LocalForward` entries and you want to run `autossh` on alternate local ports, pass `-o ClearAllForwardings=yes` and specify only the `-L` forwards you want.

With the tunnel running, you can use:

- Keycloak UI: `http://localhost:8181/admin`
- Backend API: `http://localhost:3001`

Example alternate ports (avoids conflicts):

```bash
autossh -M 0 -N \
  -o ClearAllForwardings=yes \
  -L 8181:localhost:8080 \
  -L 3001:localhost:3001 \
  -L 3322:localhost:3322 \
  p3dx-auth-vm
```

---

## Appendix A) immuDB service API (developer reference)

The immuDB integration lives in `src/services/immudb.service.js` and is used for immutable audit storage.

### `initImmuDB()`

- **Purpose**
  - Initialize connection to immuDB at startup (called by `src/server.js` before `app.listen`).
- **Reads env**
  - `IMMUDB_HOST`, `IMMUDB_PORT`, `IMMUDB_USER`, `IMMUDB_PASSWORD`, `IMMUDB_DATABASE`
- **Behavior**
  - Connects + selects DB.
  - If immuDB is unavailable, the backend continues running with console-only audit logging.

### `logAuditEvent(eventType, subjectId, metadata = {})`

- **Purpose**
  - Persist an immutable audit event.
- **Key patterns written**
  - `audit:<eventId>`
  - `audit:type:<eventType>:<eventId>`
  - `audit:subject:<subjectId>:<eventId>`
  - `audit:time:<timestamp>:<eventId>`
- **Error handling**
  - Safe fallback: should not crash request handling if immuDB is temporarily down.

### `storeWorkloadContract({ contract, datasetId, applicationId, user, metadata = {} })`

- **Purpose**
  - Persist the signed workload contract + consent metadata when a user clicks "Run Workload".
- **Call site**
  - `POST /p3dx/workloads/run`
- **Key patterns written**
  - `workload-contract:<contractId>`
  - `workload-contract:user:<userSub>:<contractId>`
  - `workload-contract:time:<timestamp>:<contractId>`
  - `workload-contract:dataset:<datasetId>:<contractId>`
  - `workload-contract:app:<applicationId>:<contractId>`
- **Notes**
  - The stored record includes: contract JSON, a sha256 `contract_hash`, user identity from the verified JWT, and a consent timestamp.

### `getWorkloadContractById(contractId)`

- **Purpose**
  - Retrieve a stored workload contract record by `contractId`.
- **Call site**
  - `GET /p3dx/workloads/contracts/:contractId`

### `getAllAuditEvents()`

- **Purpose**
  - Retrieve all events by scanning `audit:` keys.
- **Notes**
  - Filters to canonical keys `audit:<uuid>`.

### `getAuditEventsByType(eventType)`

- **Purpose**
  - Retrieve events by scanning `audit:type:<eventType>:` keys.

---

## Endpoint inventory (POC)

This is a consolidated list of the HTTP endpoints used across components in this proof-of-concept.

### Auth Backend (p3dx-aaa) — Express API

Note: the same router is mounted under both `/p3dx/*` and `/anon/*`.

- `POST /p3dx/register`
  - Register a new Keycloak user.
- `POST /p3dx/login`
  - Login and return Keycloak access/refresh tokens.
- `GET /p3dx/me`
  - Return the current authenticated user profile and roles.
- `POST /p3dx/workloads/run`
  - Forward raw workload parameters (`access_token`, `dataset_id`, `application_id`) to TOP (`POST /workload`), which owns the full contract lifecycle. Store the returned signed contract in immuDB.
- `GET /p3dx/workloads/contracts/:contractId`
  - Fetch the stored workload contract record from immuDB (backend view of the contract).
- `GET /p3dx/workloads/contracts/:contractId/result`
  - Fetch the final signed contract from TOP and return a workload “result” payload for the UI.
- `POST /p3dx/workloads/contracts/:contractId/token-verify`
  - TOP→Backend: verify TOP’s user token fingerprint (requires `X-API-Key`). Legacy — not called in the current `POST /workload` flow.
- `GET /p3dx/apps/:appId/compose-url`
  - TOP→Backend: resolve `app_id` to a docker-compose URL (requires `X-API-Key`).
- `POST /p3dx/policy`
  - Proxy policy submission to APD (data-provider role required).
- `POST /p3dx/maa-tokens`
  - Store MAA tokens for the current user (POC token storage).
- `POST /p3dx/role-requests`
  - Create a role request (user → admin workflow).
- `GET /p3dx/role-requests/my`
  - List role requests created by the current user.
- `GET /p3dx/admin/role-requests`
  - Admin: list role requests.
- `POST /p3dx/admin/role-requests/:id/decision`
  - Admin: approve/deny a role request.

### TOP (~/Top) — contract lifecycle + retrieval

- `POST /workload`
  - **Primary.** Backend→TOP: accepts `{ access_token, dataset_id, application_id }` and runs the full contract lifecycle — JWT claim extraction, contract creation, consumer HMAC signing, APD policy fetch, orchestrator RSA signing, artifact storage, and `DeployEnclave()`. Returns `{ status, contract_id, contract }`.
- `POST /contract`
  - **Legacy.** Accepts a pre-built contract from the caller and runs only the orchestrator signing + deploy pipeline (APD fetch → store → sign → compose-URL resolution → TEE deploy). Kept for backward compatibility; not called by p3dx-aaa in the current flow.
- `GET /contracts/:contractId`
  - Backend→TOP: return the stored final signed contract JSON (`{contractId}.json`) for UI result rendering.

### APD (p3dx-apd) — policy + access request lifecycle

- `GET /health`
  - Health check.
- `POST /api/v1/policy`
  - ConMan/Data-provider→APD: store a policy (also dumped to `APD_POLICY_DUMP_DIR` for POC persistence).
- `GET /api/v1/policy/{policyId}`
  - TOP→APD: fetch a policy by policy id.
- `GET /api/v1/policy/by-item/{itemId}`
  - TOP→APD: fetch a policy by dataset/item id.
- `GET /api/v1/consent/{token}/approve`
  - Provider action: approve consent using a one-time token link.
- `GET /api/v1/consent/{token}/deny`
  - Provider action: deny consent using a one-time token link.
- `POST /api/v1/tee/attestation`
  - TEE→APD callback: submit attestation report.
- `POST /api/v1/tee/result`
  - TEE→APD callback: submit computation result.
- `POST /api/v1/access-requests`
  - Consumer: create a new access request (phase 1).
- `GET /api/v1/access-requests`
  - Consumer: list own access requests.
- `GET /api/v1/access-requests/{requestId}`
  - Any authenticated user: get a specific access request.
- `POST /api/v1/access-requests/{requestId}/compute`
  - Consumer: trigger computation / TEE provisioning (phase 2).
- `GET /api/v1/access-requests/{requestId}/result`
  - Consumer: poll for encrypted result (phase 5).
- `POST /api/v1/access-requests/{requestId}/key-bundle`
  - Provider: submit encrypted key bundle (phase 4).
- `GET /api/v1/provider/access-requests`
  - Provider: list access requests assigned to provider.

### Auth UI (p3dx-auth-ui) — client-side routes

- `/login`
  - Login page.
- `/register`
  - Registration page.
- `/app/services/run`
  - Run Workload form.
- `/app/services/run/:contractId`
  - Workload Result page: shows `TEE started` and renders the final signed contract JSON.
- `/app/services/policies`
  - Policy submission form.
