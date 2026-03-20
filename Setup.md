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

Frontend (React/Vite, local dev)
  -> HTTP JSON
p3dx-aaa auth backend (Node.js/Express, VM, port `<PORT>`)
  -> Keycloak Admin API + OIDC token endpoint
Keycloak (VM, port 8080)
  -> PostgreSQL (VM local service, port 5432)

Workload orchestration (POC):

p3dx-aaa auth backend -> TOP (Go) (VM local, port 8085)
  -> TOP verifies user token fingerprint with backend and stores contract

Policy storage (optional local dev):

p3dx-aaa auth backend -> APD (Go) (VM local, port 8082)

Audit logging:
p3dx-aaa auth backend -> immuDB (VM, port 3322)

---

## 1) Ports & Access Model

### VM-side ports

- SSH: `22`
- Keycloak: `8080` (dev mode typically binds to all interfaces)
- p3dx-aaa auth backend: `3001`
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

Example (as used during verification):

```bash
export PORT=8082

export DB_HOST=localhost
export DB_PORT=5432
export DB_USER=apd
export DB_PASSWORD=apdpass
export DB_NAME=apd
export DB_SSLMODE=disable

export JWT_PRIVATE_KEY_PATH=/home/azureuser/p3dx-apd/keys/jwt_private.pem
export JWT_PUBLIC_KEY_PATH=/home/azureuser/p3dx-apd/keys/jwt_public.pem
export JWT_ISSUER=http://localhost:8082

export TEE_ORCHESTRATOR_URL=http://localhost:9999
export APD_BASE_URL=http://localhost:8082
export APD_SIGNING_KEY_PATH=/home/azureuser/p3dx-apd/keys/jwt_private.pem

# Optional (POC): dump every received policy payload into a new JSON file
export APD_POLICY_DUMP_DIR=/home/azureuser/p3dx-apd/policies

go run ./cmd/server/main.go
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

- `POST /p3dx/register`
- `POST /p3dx/login`
- `GET /p3dx/me` (protected; requires Bearer token + role `user`)

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
  "itemId": "ds-1",
  "issuedBy": "<username>",
  "rules": { "any": "json" },
  "expiresAt": "2026-03-14T00:00:00.000Z"
}
```

Notes:

- `expiresAt` is optional.
- `rules` is free-form JSON; APD stores it as-is.

#### `POST /p3dx/maa-tokens`

Note: `/anon/*` is currently kept as a backward-compatible alias for `/p3dx/*`, but new clients should use `/p3dx`.

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

From repo root:

### 12.1 Diagnose immuDB connectivity

```bash
npm run diagnose:immudb
```

### 12.2 End-to-end API test

```bash
npm run test:e2e
```

### 12.3 Full immuDB audit test suite

```bash
npm run test:immudb
```

### 12.4 Print audit events

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

### `src/` (the backend)

- **Purpose**
  - Implements the Express server + Keycloak integration + immuDB audit logging
- **How to start**

Run these commands from the backend repo root (commonly `~/p3dx-aaa`). If you checked out a working copy named `p3dx-aaa-local` on this branch, use that directory instead.

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

---

## 12.5 Workload contract (Run Workload)

When a user clicks "Run Workload" in the UI, the backend creates a workload contract using the vendored Go generator, generates a user-side consent proof/signature, and persists the signed contract + consent metadata to immuDB.

### API endpoints

- `POST /p3dx/workloads/run`
  - **Auth**: requires Keycloak JWT (`Authorization: Bearer ...`) and `user` role
  - **Body**: `{ "datasetId": "...", "applicationId": "..." }`
  - **Response**: `{ status: "SUCCESS", contract: { ... }, top: { ... } }`
  - **Behavior**
    - Generates a signed workload contract via the Go contract generator.
    - Stores the contract + consent metadata in immuDB.
    - Optionally submits the generated contract to TOP (TEE Orchestration component) if enabled via env.
      - **TOP endpoint**: `POST ${TOP_BASE_URL}${TOP_CONTRACT_ENDPOINT}` (default `/contract`)
      - **Auth**: passes the same user JWT as `Authorization: Bearer ...`
      - **Payload**
        - If `TOP_PAYLOAD_MODE=raw`: sends the generated contract JSON as-is.
        - If `TOP_PAYLOAD_MODE=wrapper` (default): sends `{ "access_token": "...", "signature": "...", "contract": { ... } }`.
- `GET /p3dx/workloads/contracts/:contractId/result`
  - **Auth**: Bearer JWT (user)
  - **Response**: `{ status: "SUCCESS", tee_status: "STARTED", contract_id: "...", app_id: "...", signed_contract: { ... } }`
  - **Behavior**
    - Fetches the fully-signed contract (including orchestrator signature) from TOP.
    - Returns a lightweight workload “result” payload used by the UI.
- `GET /p3dx/workloads/contracts/:contractId`
  - **Auth**: requires Keycloak JWT and `user` role
  - **Response**: `{ status: "SUCCESS", record: { ... } }`

### Required backend env vars

Add these to your backend `.env` (do not commit secrets):

- `CONTRACT_SERVER_SECRET`
  - Strong random secret used by the contract generator to produce the user-side consent proof/signature.

Optional contract generation env vars:

- `CONTRACT_GEN_BIN`
  - Path to the built Go binary (recommended under systemd).
  - If empty, the backend falls back to `go run .` in `./contract-gen` (dev mode).
- `CONTRACT_OVERRIDES_JSON`
  - JSON string that is passed to the generator as `overrides` and merged over the generator defaults.
  - Use this to inject real dataset/app/provider metadata (names, ids, urls, hashes, etc.) without changing Go code.

Optional TOP integration env vars (see `.env.example`):

- `TOP_ENABLED=true`
- `TOP_BASE_URL` (example: `http://localhost:8085`)
- `TOP_CONTRACT_ENDPOINT` (default: `/contract`)
- `TOP_PAYLOAD_MODE` (default: `wrapper`)
- `TOP_AUTH_MODE=bearer`
- `TOP_REQUIRED=true` to fail `POST /p3dx/workloads/run` if TOP submission fails

Console logging (POC):

- Backend emits success-step logs prefixed with:
  - `[P3DX_STEP_OK]`
- TOP emits success-step logs prefixed with:
  - `[TOP_STEP_OK]`

TOP token consistency verification (TOP -> backend):

- Backend stores a `sha256` fingerprint of the user access token used to create the contract.
- TOP computes the same fingerprint for the token it received and verifies it with:
  - `POST /p3dx/workloads/contracts/:contractId/token-verify`
  - Header: `X-API-Key: <TOP_BACKEND_API_KEY>`
  - Body: `{ "token_fingerprint": "<sha256 hex>" }`
- Backend replies `{ status: "SUCCESS", match: true|false }`.

Env:

- `TOP_BACKEND_API_KEY` (required to enable the verification endpoint)

TOP runtime configuration (POC):

- TOP is a separate Go project (in this workspace under `~/Top`).
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
go run .
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

- Backend (`p3dx-aaa-local`)
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

The **Auth Backend** (`p3dx-aaa-local`) is the central API gateway for the UI. It handles user authentication (Keycloak JWT), generates the workload contract, writes an immutable audit record to immuDB, and orchestrates a submission to TOP.

The **Trusted Orchestrator Platform (TOP)** (`~/Top`) is the contract-ingestion component. It verifies that the user token TOP received matches what the backend used to generate the contract (token fingerprint verification), fetches the dataset policy from APD, embeds the orchestrator signature in the contract, persists the signed contract to disk, resolves a docker-compose reference by `app_id` via the backend, and triggers the “TEE deploy” step (dry-run by default).

The **APD** (`p3dx-apd`) is the policy service. A data-provider submits a policy into APD, and TOP fetches that policy by dataset id (`itemId`) before it accepts a contract. For POC resiliency, APD dumps received policies to disk and will reload policies from the dump directory on-demand when `/by-item/{itemId}` is called.

### Run Workload: step-by-step execution

1) The consumer signs in to Keycloak via the UI. The UI stores the access token in `localStorage`.

2) The consumer opens **Services → Run Workload** and clicks **Run Workload**.

3) The UI calls the backend `POST /p3dx/workloads/run` with the user JWT (Bearer token) and the selected `{ datasetId, applicationId }`.

4) The backend generates a workload contract using the Go generator (vendored under `contract-gen`). The contract includes a stable `contract_id` and a user-side signature/consent proof produced during generation.

5) The backend writes an immutable record to immuDB keyed by `workload-contract:<contractId>` and also stores a `sha256` fingerprint of the user access token that was used to create the contract. This fingerprint is later used by TOP to validate token consistency.

6) If TOP integration is enabled, the backend submits the contract to TOP (`POST ${TOP_BASE_URL}${TOP_CONTRACT_ENDPOINT}`) and passes the same user JWT along.

7) TOP receives the contract and computes its own `sha256` fingerprint of the user JWT it received. TOP calls back to the backend (`POST /p3dx/workloads/contracts/:contractId/token-verify`, protected by `TOP_BACKEND_API_KEY`) to confirm that TOP’s token fingerprint matches the one stored by the backend. If the token does not match, TOP rejects the contract.

8) TOP extracts `datasetId` from the contract (`contract.data_provider_terms.data_resource_id`) and fetches the access policy from APD (`GET ${APD_BASE_URL}/api/v1/policy/by-item/{itemId}`). If the policy is missing (404) or APD fails, TOP rejects the contract (current POC behavior).

9) TOP signs the contract (or uses a mock signature if no key is configured) and embeds the orchestrator signature fields into `contract.signatures.*`. TOP then overwrites the stored contract artifacts on disk (`{contractId}.bin` and `{contractId}.json`).

10) TOP extracts `app_id` from `contract.application_provider_terms.app_id` and calls back to the backend (`GET /p3dx/apps/{appId}/compose-url`, protected by `TOP_BACKEND_API_KEY`) to resolve the docker-compose reference for that `app_id`.

11) TOP calls `DeployEnclave()` with the resolved `compose_url`. Since the deploy API is not hosted yet, TOP runs in `TEE_DEPLOY_DRY_RUN=true` by default, so the deploy call is skipped while TOP still logs `TEE started`.

12) The UI receives the successful response from `POST /p3dx/workloads/run`, extracts `contract_id`, and navigates to `/app/services/run/:contractId`.

13) The Workload Result page calls `GET /p3dx/workloads/contracts/:contractId/result`. The backend fetches the final signed contract from TOP (`GET ${TOP_BASE_URL}/contracts/:contractId`) and returns it to the UI. The UI displays `TEE started` and renders the signed contract JSON.

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

### Start backend

```bash
cd ~/p3dx-aaa
npm start
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

### Auth Backend (p3dx-aaa-local) — Express API

Note: the same router is mounted under both `/p3dx/*` and `/anon/*`.

- `POST /p3dx/register`
  - Register a new Keycloak user.
- `POST /p3dx/login`
  - Login and return Keycloak access/refresh tokens.
- `GET /p3dx/me`
  - Return the current authenticated user profile and roles.
- `POST /p3dx/workloads/run`
  - Generate a signed workload contract, store it in immuDB, and optionally submit it to TOP.
- `GET /p3dx/workloads/contracts/:contractId`
  - Fetch the stored workload contract record from immuDB (backend view of the contract).
- `GET /p3dx/workloads/contracts/:contractId/result`
  - Fetch the final signed contract from TOP and return a workload “result” payload for the UI.
- `POST /p3dx/workloads/contracts/:contractId/token-verify`
  - TOP→Backend: verify TOP’s user token fingerprint matches the backend’s stored fingerprint (requires `X-API-Key`).
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

### TOP (~/Top) — contract ingestion + retrieval

- `POST /contract`
  - Backend→TOP: ingest a workload contract, verify token fingerprint with backend, fetch policy from APD, embed orchestrator signature, resolve compose URL, and trigger `DeployEnclave()`.
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
