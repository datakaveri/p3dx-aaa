# p3dx-aaa Auth System — Full Setup & Handover Guide

This document describes the complete end-to-end setup for:

- Keycloak (IdP) running on an Azure VM (Ubuntu 24.04)
- PostgreSQL (Keycloak internal DB) running locally on the VM
- p3dx-aaa auth backend (Node.js/Express) running on the VM
- immuDB (audit ledger) running on the VM (Docker)
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

Policy storage (optional local dev):

p3dx-aaa auth backend -> APD (Go) (VM local, port 8082)

Audit logging:
p3dx-aaa auth backend -> immuDB (VM, port 3322)

---

## 1) Ports & Access Model

### VM-side ports

- SSH: `22`
- Keycloak: `8080` (dev mode typically binds to all interfaces)
- p3dx-aaa auth backend: `3000`
- PostgreSQL (Keycloak DB): `5432` (local to VM)
- immuDB: `3322`
- APD (Go, local dev): `8082` (optional; used for policy submissions)

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

go run ./cmd/server/main.go
```

Expected:

- `APD server listening on :8082`

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
  - **Response**: `{ status: "SUCCESS", contract: { ... } }`
- `GET /p3dx/workloads/contracts/:contractId`
  - **Auth**: requires Keycloak JWT and `user` role
  - **Response**: `{ status: "SUCCESS", record: { ... } }`

### Required backend env vars

Add these to your backend `.env` (do not commit secrets):

- `CONTRACT_SERVER_SECRET`
  - Strong random secret used by the contract generator to produce the user-side consent proof/signature.
- `CONTRACT_GEN_BIN`
  - Path to the built Go binary (recommended under systemd).
  - If empty, the backend falls back to `go run .` in `./contract-gen` (dev mode).

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
  -L 8182:localhost:8080 \
  -L 3002:localhost:3001 \
  -L 3323:localhost:3322 \
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
