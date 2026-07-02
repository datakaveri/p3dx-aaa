# p3dx-aaa Auth System — Full Setup & Handover Guide

This document describes the complete end-to-end setup for:

- Keycloak (IdP) running on an Azure VM (Ubuntu 24.04)
- PostgreSQL (Keycloak internal DB + APD DB) running locally on the VM
- p3dx-aaa auth backend (Node.js/Express) running on the VM
- immuDB (audit + data ledger) running on the VM (Docker via snap)
- TOP (Trusted Orchestrator Protocol) running locally for POC (Go, port 8085)
- APD (Access Policy Database) running locally for POC (Go, port 8082)
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

```
p3dx-aaa -> TOP (Go, port 8085)
  -> TOP creates contract, consumer-HMAC-signs + orchestrator-RSA-signs it
  -> TOP fetches policy from APD (step 3 of 11)
  -> TOP triggers TEE deploy (dry-run by default)
  -> TOP returns fully signed contract to p3dx-aaa
  -> p3dx-aaa stores signed contract in immuDB
```

Policy storage:

```
p3dx-aaa -> APD (Go, port 8082)   POST /p3dx/policy proxied to APD
TOP      -> APD                   GET /api/v1/policy/by-item/:datasetId (step 3 gate)
```

Audit + data logging:

```
p3dx-aaa -> immuDB (port 3322)
  - auth audit events (register, login, profile access, JWT failures)
  - workload contracts
  - MAA attestation tokens
  - Spider run history        (POST /p3dx/run-history)
  - Spider agent history      (POST /p3dx/agent-history)
  - Spider chat history       (POST /p3dx/chat-history)
```

---

## 1) Ports & Access Model

### VM-side ports

| Port | Service | Notes |
|------|---------|-------|
| `443` | nginx | Public entry point; serves auth UI + proxies API |
| `22` | SSH | — |
| `8080` | Keycloak | Dev mode; binds to all interfaces |
| `3001` | p3dx-aaa | Managed by systemd; nginx proxies to this |
| `5432` | PostgreSQL | Local only; used by Keycloak and APD |
| `3322` | immuDB | Docker container via snap |
| `8082` | APD | Go binary; policy storage + access request lifecycle |
| `8085` | TOP | Go binary; full contract pipeline |

### Recommended access from a developer machine (Mac/Linux)

Use SSH port forwarding; do not expose admin services publicly.

```bash
ssh -L 8181:localhost:8080 \
    -L 3001:localhost:3001 \
    -L 3322:localhost:3322 \
    azureuser@<VM_PUBLIC_IP>
```

- Keycloak Admin UI: `http://localhost:8181/admin`
- Backend API: `http://localhost:3001`
- immuDB: `localhost:3322`

---

## 2) VM connection

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

### 3.3 Install Go 1.22+ (TOP + APD requirement)

```bash
sudo apt install golang-go -y
go version   # must be 1.22+
```

---

## 4) PostgreSQL setup

PostgreSQL is used by both Keycloak (identity store) and APD (policy + access request store).

### 4.1 Install and start PostgreSQL

```bash
sudo apt install postgresql postgresql-contrib -y
sudo systemctl enable --now postgresql
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

### 4.3 Create APD DB and user

Still inside `psql`:

```sql
CREATE DATABASE apd;
CREATE USER apd WITH PASSWORD 'apdpass';
ALTER DATABASE apd OWNER TO apd;
GRANT ALL PRIVILEGES ON DATABASE apd TO apd;
\q
```

### 4.4 Ensure password auth is enabled

```bash
sudo nano /etc/postgresql/*/main/pg_hba.conf
```

Ensure these entries exist:

```text
local   all   all                     scram-sha-256
host    all   all   127.0.0.1/32      scram-sha-256
host    all   all   ::1/128           scram-sha-256
```

```bash
sudo systemctl restart postgresql
```

Verify Keycloak DB login:

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

### 5.2 Clean Keycloak state (only when redoing setup)

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

- `PostgreSQL JDBC driver`
- `Profile dev activated`
- `Listening on: http://<VM_HOST>:8080`

For repeated use, manage Keycloak via systemd (see §17).

---

## 6) Access Keycloak Admin Console (from your laptop)

SSH port forward:

```bash
ssh -L 8181:localhost:8080 azureuser@<VM_PUBLIC_IP>
```

Open `http://localhost:8181/admin`.

### 6.1 Create initial admin user (first run only)

Keycloak will prompt you to create the first admin user on first launch.

---

## 7) Keycloak realm/client configuration

### 7.1 Realm

- Realm: `master` (current setup)

### 7.2 Client

- Client ID: `anon-backend`
- Client type: confidential
- Direct Access Grants: **enabled** (required for ROPC login flow)
- Client Secret: configured in backend `.env` as `KEYCLOAK_CLIENT_SECRET`

### 7.3 Roles

The following realm roles must exist in the `master` realm:

| Role | How granted | Required for |
|------|-------------|--------------|
| `user` | Auto-assigned on registration | Running workloads, accessing profile |
| `data-provider` | Admin approval via role request | Submitting dataset policies |
| `application-provider` | Admin approval via role request | — |
| `admin` | Manually assigned | Approving/rejecting role requests in UI |

Create `user`, `data-provider`, `application-provider` via Keycloak Admin API:

```bash
KC_ADMIN_PASS=<KEYCLOAK_ADMIN_PASSWORD>
TOKEN=$(curl -s -X POST http://localhost:8080/realms/master/protocol/openid-connect/token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password&client_id=admin-cli&username=keycloak-admin&password=${KC_ADMIN_PASS}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")

for ROLE in user data-provider application-provider; do
  curl -s -X POST http://localhost:8080/admin/realms/master/roles \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$ROLE\"}"
done
```

(`admin` role already exists in master by default.)

### 7.4 Platform admin user

The platform needs one dedicated admin user who can log into the UI and approve/reject role requests. This is separate from the Keycloak admin account.

**Create via p3dx-aaa register endpoint** (backend must be running):

```bash
curl -s -X POST http://localhost:3001/p3dx/register \
  -H "Content-Type: application/json" \
  -d '{"username":"Admin","email":"admin@p3dx.local","password":"Admin@123","firstName":"Admin","lastName":"User"}'
```

**Assign the `admin` realm role:**

```bash
ADMIN_ID=$(curl -s "http://localhost:8080/admin/realms/master/users?username=Admin&exact=true" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['id'])")

ADMIN_ROLE_ID=$(curl -s "http://localhost:8080/admin/realms/master/roles/admin" \
  -H "Authorization: Bearer $TOKEN" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

curl -s -X POST "http://localhost:8080/admin/realms/master/users/$ADMIN_ID/role-mappings/realm" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "[{\"id\":\"$ADMIN_ROLE_ID\",\"name\":\"admin\"}]"
```

**Current platform admin credentials:**

| Field | Value |
|-------|-------|
| Username | `Admin` |
| Password | `Admin@123` |
| Email | `admin@p3dx.local` |
| Keycloak role | `admin` |

---

## 8) immuDB setup (audit + data ledger)

immuDB runs on the VM via Docker (installed via snap).

### 8.1 Create volume and start immuDB

```bash
sudo /snap/bin/docker volume create immudb-data

sudo /snap/bin/docker run -d \
  --name immudb \
  -p 3322:3322 \
  -v immudb-data:/var/lib/immudb \
  codenotary/immudb:latest

sudo /snap/bin/docker ps | grep immudb
```

### 8.2 Create database and user (automated)

```bash
cd ~/p3dx-aaa-local
npm run setup:immudb
```

This creates:
- Database: `anon_audit_clean`
- User: `anon_backend` (readwrite on `anon_audit_clean`)

### 8.3 Manual approach (via immuadmin)

```bash
sudo /snap/bin/docker exec -it immudb immuadmin login immudb

sudo /snap/bin/docker exec -it immudb immuadmin database create anon_audit_clean
sudo /snap/bin/docker exec -it immudb immuadmin user create anon_backend readwrite anon_audit_clean
```

### 8.4 What is stored in immuDB

immuDB is the single store for all audit and operational data. Key namespaces:

| Prefix | Written by | Content |
|--------|-----------|---------|
| `audit:` | p3dx-aaa | Auth events (register, login, JWT failures, profile access) |
| `workload-contract:` | p3dx-aaa | Signed workload contracts returned by TOP |
| `maa:` | p3dx-aaa | MAA attestation tokens (hit externally by TEE) |
| `run-history:` | p3dx-aaa | Spider anonymisation run records |
| `agent-history:` | p3dx-aaa | Spider AI agent analysis records |
| `chat-history:` | p3dx-aaa | Spider chat session records |
| `role-request:` | p3dx-aaa | Role request lifecycle records |

---

## 9) p3dx-aaa auth backend setup

**Repo:** `~/p3dx-aaa-local`
**Managed by:** systemd (`p3dx-aaa-auth-backend.service`)
**Port:** 3001

### 9.1 Prerequisites

- Node.js v18+
- Keycloak running and reachable
- immuDB running and reachable

### 9.2 Install dependencies

```bash
cd ~/p3dx-aaa-local
npm install
```

### 9.3 Configure environment

Edit `.env` in repo root (copy from `.env.example` to start):

```env
PORT=3001

KEYCLOAK_BASE_URL=http://localhost:8080
KEYCLOAK_REALM=master
KEYCLOAK_ADMIN_USER=keycloak-admin
KEYCLOAK_ADMIN_PASSWORD=<KEYCLOAK_ADMIN_PASSWORD>
KEYCLOAK_CLIENT_ID=anon-backend
KEYCLOAK_CLIENT_SECRET=<CLIENT_SECRET>

IMMUDB_HOST=127.0.0.1
IMMUDB_PORT=3322
IMMUDB_USER=anon_backend
IMMUDB_PASSWORD=<IMMUDB_USER_PASSWORD>
IMMUDB_DATABASE=anon_audit_clean

APD_BASE_URL=http://localhost:8082

TOP_ENABLED=true
TOP_REQUIRED=true
TOP_BASE_URL=http://localhost:8085
TOP_AUTH_MODE=bearer
TOP_BACKEND_API_KEY=<SHARED_API_KEY>

CORS_ORIGINS=https://auth.p3dx.iudx.org.in,https://spider.p3dx.iudx.org.in
```

### 9.4 Start the backend

```bash
# via systemd (production / recommended)
sudo systemctl start p3dx-aaa-auth-backend.service
sudo systemctl status p3dx-aaa-auth-backend.service

# manually (development)
cd ~/p3dx-aaa-local
npm start        # node src/server.js
npm run dev      # nodemon (auto-reload)
```

Expected output:

```
✓ immuDB connected and database selected
p3dx-aaa auth backend running on port 3001
```

---

## 9.5) APD (Go) local setup

**Repo:** `~/p3dx-apd`
**Port:** 8082

APD serves two roles:
1. **Policy oracle** — stores dataset access policies; queried by TOP at step 3 of the contract pipeline
2. **Access request lifecycle** — full 5-phase TEE-backed access request flow (not used in current P3DX POC flow)

### 9.5.1 Apply DB schema

```bash
psql -h localhost -U apd -d apd -f ~/p3dx-apd/schema.sql
```

### 9.5.2 Keys (EC P-256)

```bash
cd ~/p3dx-apd
mkdir -p keys
openssl ecparam -name prime256v1 -genkey -noout -out keys/jwt_private.pem
openssl ec -in keys/jwt_private.pem -pubout -out keys/jwt_public.pem
chmod 600 keys/jwt_private.pem
```

### 9.5.3 Environment

`/home/azureuser/p3dx-apd/.env` (already configured — do not commit):

```env
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

### 9.5.4 Build and run

```bash
cd ~/p3dx-apd
go build -o /tmp/p3dx-apd ./cmd/server/main.go
set -a && source .env && set +a
/tmp/p3dx-apd
```

Or use the platform startup script (recommended):

```bash
~/start-p3dx.sh
```

Expected: `APD server listening on :8082`

### 9.5.5 Verify

```bash
curl -s http://localhost:8082/health
```

---

## 9.6) TOP (Go) local setup

**Repo:** `~/Top`
**Port:** 8085

TOP owns the full 11-step workload contract pipeline. p3dx-aaa delegates everything to TOP via `POST /workload`.

### 9.6.1 RSA keypair (orchestrator signing)

```bash
cd ~/Top
mkdir -p keys
openssl genrsa -out keys/orch_private.pem 2048
openssl rsa -in keys/orch_private.pem -pubout -out keys/orch_public.pem
chmod 600 keys/orch_private.pem

# Verify it is RSA-2048
openssl rsa -in keys/orch_private.pem -text -noout 2>/dev/null | head -3
# Expected: Private-Key: (2048 bit, 2 primes)
```

### 9.6.2 Environment

`/home/azureuser/Top/.env` (do not commit secrets):

```env
PORT=8085

BACKEND_URL=http://localhost:3001
BACKEND_API_KEY=<same value as TOP_BACKEND_API_KEY in p3dx-aaa .env>

APD_BASE_URL=http://localhost:8082

CONTRACT_SERVER_SECRET=<hex string, e.g. 64 chars>

ORCH_PRIVATE_KEY_PATH=/home/azureuser/Top/keys/orch_private.pem

STORE_PATH=/home/azureuser/Top/contracts
STORE_KEY=<32-byte string>

TEE_DEPLOY_DRY_RUN=true
```

> If `ORCH_PRIVATE_KEY_PATH` is not set, TOP falls back to a mock signature — **benchmarks and production runs require a real key**.

### 9.6.3 Build and run

```bash
cd ~/Top
go build -o /tmp/top-server .
/tmp/top-server
```

Or use the platform startup script:

```bash
~/start-p3dx.sh
```

### 9.6.4 The 11-step contract pipeline

When TOP receives `POST /workload` with `{ access_token, dataset_id, application_id }`:

| Step | Action |
|------|--------|
| 1 | Validate request |
| 2 | Extract JWT claims (`sub`, `sid`, `iat`, `exp`) — no signature check, just decode |
| 3 | `CreateContract()` — UUID, 90-day lifecycle, parties, terms |
| 4 | Consumer HMAC-SHA256: `HMAC(hash\|userID\|sessionID\|iat, CONTRACT_SERVER_SECRET)` |
| 5 | **Policy gate** — `GET APD/api/v1/policy/by-item/{datasetId}`; 404 = abort |
| 6 | Store unsigned contract (AES-256-GCM `.bin` + plain `.json`) |
| 7 | Orchestrator RSA-PKCS1v15-SHA256 sign; embed in `signatures.orchestrator_signature` |
| 8 | Overwrite stored files with signed contract |
| 9 | Fetch compose URL — `GET BACKEND/p3dx/apps/{appId}/compose-url` (X-API-Key) |
| 10 | `DeployEnclave()` — dry-run by default |
| 11 | Return `{ status, contract_id, contract }` |

---

## 9.7) nginx setup

nginx is the public entry point for `https://auth.p3dx.iudx.org.in`.

### 9.7.1 Config location

```
/etc/nginx/sites-available/auth.p3dx.iudx.org.in
/etc/nginx/sites-enabled/auth.p3dx.iudx.org.in  (symlink)
```

### 9.7.2 Config structure

```nginx
server {
    listen 443 ssl;
    server_name auth.p3dx.iudx.org.in;

    location /assets/ {
        root /home/azureuser/p3dx-auth-ui/dist;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /anon/ { proxy_pass http://127.0.0.1:3001; ... }
    location /p3dx/ { proxy_pass http://127.0.0.1:3001; ... }

    location / {
        root /home/azureuser/p3dx-auth-ui/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

### 9.7.3 Reload after config changes

```bash
sudo nginx -t
sudo systemctl reload nginx
```

### 9.7.4 How GET /p3dx/login works (Spider logout redirect)

1. Spider redirects browser to `https://auth.p3dx.iudx.org.in/p3dx/login`
2. nginx proxies `/p3dx/` to backend
3. Backend `GET /login` returns `302 → /login`
4. Browser follows to `https://auth.p3dx.iudx.org.in/login`
5. nginx serves `dist/index.html` (SPA catch-all)
6. React Router renders Login page

Spider must be configured to redirect logout to `https://auth.p3dx.iudx.org.in/p3dx/login`. Also configure this URL in Keycloak admin under `anon-backend` client → **Valid post logout redirect URIs**.

---

## 9.8) Auth UI deployment (p3dx-auth-ui)

**Repo:** `~/p3dx-auth-ui`

### 9.8.1 Production environment file

`/home/azureuser/p3dx-auth-ui/.env.production`:

```env
VITE_BACKEND_URL=https://auth.p3dx.iudx.org.in
VITE_APP_URL=https://auth.p3dx.iudx.org.in
```

### 9.8.2 Build and deploy

```bash
cd ~/p3dx-auth-ui
npm install
npm run build   # outputs to dist/
```

nginx serves the new `dist/` immediately — no nginx restart needed.

### 9.8.3 Directory permissions (once only)

```bash
chmod o+x /home/azureuser
chmod o+x /home/azureuser/p3dx-auth-ui
chmod o+x /home/azureuser/p3dx-auth-ui/dist
```

---

## 10) API endpoints

Base URL: `http://localhost:3001` (VM local) or `https://auth.p3dx.iudx.org.in` (public)

Note: the same router is mounted under both `/p3dx/*` and `/anon/*`. Spider uses `/anon/login`; both paths work identically.

### 10.1 Auth endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/p3dx/login` | None | Redirect to `/login` React page (Spider logout target) |
| `POST` | `/p3dx/login` | None | ROPC login → `{ access_token, refresh_token, expires_in }` |
| `POST` | `/p3dx/register` | None | Register new Keycloak user + assign `user` role |
| `GET` | `/p3dx/me` | JWT + `user` or `admin` | Return profile + roles |

### 10.2 Workload contract endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/p3dx/workloads/run` | JWT + `user` | Forward to TOP, store signed contract in immuDB |
| `GET` | `/p3dx/workloads/contracts/:contractId` | JWT + `user` | Fetch contract audit record from immuDB |
| `GET` | `/p3dx/workloads/contracts/:contractId/result` | JWT + `user` | Fetch signed contract from TOP for UI display |

### 10.3 Service-to-service endpoints (X-API-Key)

| Method | Path | Caller | Description |
|--------|------|--------|-------------|
| `POST` | `/p3dx/workloads/contracts/:contractId/token-verify` | TOP | Legacy token fingerprint check (not used in current flow) |
| `GET` | `/p3dx/apps/:appId/compose-url` | TOP | Resolve app ID to docker-compose URL |

### 10.4 Policy endpoint

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/p3dx/policy` | JWT + `data-provider` role | Proxy policy submission to APD |

### 10.5 MAA token endpoint

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/p3dx/maa-tokens` | JWT + `user` | Store MAA attestation tokens in immuDB (hit externally by TEE) |

### 10.6 Spider data endpoints (no auth — hit externally by Spider)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/p3dx/run-history` | None | Store anonymisation run record in immuDB |
| `POST` | `/p3dx/agent-history` | None | Store AI agent analysis record in immuDB |
| `POST` | `/p3dx/chat-history` | None | Store chat session record in immuDB |

**run-history payload:**
```json
{
  "username": "kailash@datakaveri.org",
  "blob_url": "https://...",
  "run_config": { "k": 5, "suppression_limit": 10, "quasi_identifiers": [...], "sensitive_column": "Disease" },
  "status": "completed",
  "started_at": "2026-06-25T13:45:00Z",
  "completed_at": "2026-06-25T13:47:23Z",
  "duration_ms": 143000,
  "output_blob_url": "https://...",
  "error_message": null
}
```

**agent-history payload:**
```json
{
  "username": "kailash@datakaveri.org",
  "session_id": "sess_f4a2c891-3b10-4d7e",
  "blob_url": "https://...",
  "dataset_name": "synthetic_profiles.csv",
  "columns_scanned": ["Customer ID", "Full Name", ...],
  "suggestions": {
    "Full Name": { "technique": "mask", "confidence": 0.97 },
    "Aadhaar":   { "technique": "suppress", "confidence": 0.99 }
  },
  "model_used": "claude-sonnet-4-6",
  "created_at": "2026-06-25T13:40:11Z"
}
```

**chat-history payload:**
```json
{
  "username": "kailash@datakaveri.org",
  "session_id": "sess_f4a2c891-3b10-4d7e",
  "blob_url": "https://...",
  "role": "user",
  "message": "Why is Age flagged as quasi-identifier and not suppressed?",
  "created_at": "2026-06-25T13:41:02Z"
}
```

All three endpoints return `201 { status: "SUCCESS", record: { id: "<uuid>", ...payload } }`. The `id` is a UUID generated server-side.

### 10.7 Role request endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/p3dx/role-requests` | JWT + `user` | Create role request (allowed: `data-provider`, `application-provider`) |
| `GET` | `/p3dx/role-requests/my` | JWT + `user` or `admin` | List current user's own requests |
| `GET` | `/p3dx/admin/role-requests` | JWT + `admin` | List all requests (optional `?status=PENDING\|APPROVED\|REJECTED`) |
| `POST` | `/p3dx/admin/role-requests/:id/decision` | JWT + `admin` | Approve or reject; if approved, assigns role in Keycloak |

---

## 11) immuDB key namespaces reference

Each namespace uses multi-key indexing for flexible querying.

### `audit:` — auth events

```
audit:{eventId}                          primary
audit:type:{eventType}:{eventId}         filter by type
audit:subject:{subjectId}:{eventId}      filter by user
audit:time:{timestamp}:{eventId}         chronological
```

Event types: `USER_REGISTER_SUCCESS`, `USER_REGISTER_FAILED`, `USER_REGISTER_ERROR`, `USER_LOGIN_SUCCESS`, `USER_LOGIN_FAILED`, `USER_PROFILE_ACCESS`, `JWT_VERIFY_FAILED`, `MAA_TOKENS_STORED`, `ROLE_REQUEST_CREATED`, `ROLE_REQUEST_DECIDED`

### `workload-contract:` — signed contracts

```
workload-contract:{contractId}
workload-contract:user:{userSub}:{contractId}
workload-contract:time:{timestamp}:{contractId}
workload-contract:dataset:{datasetId}:{contractId}
workload-contract:app:{applicationId}:{contractId}
```

### `maa:` — MAA attestation tokens

```
maa:{eventId}
maa:user:{userId}:{eventId}
maa:session:{sessionHash}:{eventId}
maa:time:{timestamp}:{eventId}
```

### `run-history:` — Spider anonymisation runs

```
run-history:{id}
run-history:user:{username}:{id}
run-history:time:{timestamp}:{id}
```

### `agent-history:` — Spider AI agent analyses

```
agent-history:{id}
agent-history:user:{username}:{id}
agent-history:session:{session_id}:{id}
agent-history:time:{timestamp}:{id}
```

### `chat-history:` — Spider chat sessions

```
chat-history:{id}
chat-history:user:{username}:{id}
chat-history:session:{session_id}:{id}
chat-history:time:{timestamp}:{id}
```

### `role-request:` — role request workflow

```
role-request:{requestId}
role-request:user:{userId}:{requestId}
role-request:role:{roleName}:{requestId}
role-request:status:{status}:{requestId}
```

---

## 12) Verification / test commands

All commands run from `~/p3dx-aaa-local`.

### 12.1 Diagnose immuDB connectivity

```bash
npm run diagnose:immudb
```

### 12.2 End-to-end auth test (register → login → profile)

```bash
npm run test:e2e
```

### 12.3 Workload contract test

```bash
npm run test:workload

# With overrides:
BASE_URL=http://localhost:3001 \
TEST_USERNAME=alice TEST_PASSWORD=secret \
DATASET_ID=ds-001 APPLICATION_ID=app-1 \
npm run test:workload
```

### 12.4 Policy submission test (requires `data-provider` role + APD running)

```bash
TEST_DP_USERNAME=<user> TEST_DP_PASSWORD=<pass> npm run test:policy
```

### 12.5 Role request workflow test (requires admin account)

```bash
TEST_ADMIN_USERNAME=Admin TEST_ADMIN_PASSWORD=Admin@123 npm run test:role-requests
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

### 12.9 Quick smoke test for Spider data endpoints

```bash
# run-history
curl -s -X POST http://localhost:3001/p3dx/run-history \
  -H "Content-Type: application/json" \
  -d '{"username":"test@example.com","blob_url":"https://example.com/data.enc","status":"completed","duration_ms":1000}' | jq .

# agent-history
curl -s -X POST http://localhost:3001/p3dx/agent-history \
  -H "Content-Type: application/json" \
  -d '{"username":"test@example.com","session_id":"sess_test","dataset_name":"test.csv","suggestions":{},"model_used":"claude-sonnet-4-6"}' | jq .

# chat-history
curl -s -X POST http://localhost:3001/p3dx/chat-history \
  -H "Content-Type: application/json" \
  -d '{"username":"test@example.com","session_id":"sess_test","role":"user","message":"Hello"}' | jq .
```

---

## 13) Viewing stored data with immuclient

### 13.1 On the VM (Linux)

```bash
sudo /snap/bin/docker run --rm -it --network host codenotary/immuclient:latest
```

Inside immuclient:

```text
login anon_backend -a 127.0.0.1 -p 3322
use anon_audit_clean
scan audit:
scan run-history:
scan agent-history:
scan chat-history:
```

Note: use `scan prefix:` without quotes.

### 13.2 From a Mac (SSH tunnel)

```bash
ssh -L 3322:localhost:3322 azureuser@<VM_PUBLIC_IP>
docker run --rm -it codenotary/immuclient:latest
```

Inside:

```text
login anon_backend -a 127.0.0.1 -p 3322
use anon_audit_clean
scan audit:
```

---

## 14) Operational notes / troubleshooting

### 14.1 Backend starts but immuDB is "console-only"

```bash
sudo /snap/bin/docker ps | grep immudb   # check container is running
npm run diagnose:immudb                  # check credentials
npm run setup:immudb                     # re-provision if needed
```

### 14.2 Login returns 401

- Confirm user exists in Keycloak
- Confirm `anon-backend` client has Direct Access Grants enabled
- Confirm `.env` has correct `KEYCLOAK_CLIENT_SECRET`

### 14.3 Keycloak admin UI not accessible

- Check Keycloak process on VM
- Ensure SSH port forward `8181→8080` is active

### 14.4 Run Workload returns 502 TOP_SUBMISSION_FAILED

`TOP_REQUIRED=true` is set and TOP submission failed. Checklist:

- TOP is running: `curl http://localhost:8085/health` (no health endpoint — check process)
- TOP `.env` has `BACKEND_URL`, `BACKEND_API_KEY`, `APD_BASE_URL`, `CONTRACT_SERVER_SECRET`
- `ORCH_PRIVATE_KEY_PATH` points to a real RSA-2048 key (not absent — absent = mock signature)
- Backend `.env` `TOP_BACKEND_API_KEY` matches TOP `.env` `BACKEND_API_KEY`
- Temporarily set `TOP_REQUIRED=false` to debug without failing the request

### 14.5 Spider data endpoints returning 500

- Check backend logs: `sudo journalctl -u p3dx-aaa-auth-backend.service -f`
- Confirm immuDB is connected (startup log: `✓ immuDB connected and database selected`)
- Confirm payload is valid JSON with `Content-Type: application/json`

### 14.6 Spider logout redirect lands on wrong page

- Set Spider logout redirect URL to `https://auth.p3dx.iudx.org.in/p3dx/login`
- Add this URL to Keycloak `anon-backend` client → Valid post logout redirect URIs

---

## 15) Start/Stop summary

### Recommended: single-command startup

```bash
~/start-p3dx.sh   # starts everything: systemd services + APD + TOP + UI
~/stop-p3dx.sh    # stops everything
```

Logs:

```bash
tail -f /tmp/p3dx-apd.log /tmp/p3dx-top.log /tmp/p3dx-ui.log
```

### Manual per-service

```bash
# PostgreSQL
sudo systemctl start postgresql

# immuDB
sudo /snap/bin/docker start immudb

# Keycloak
cd ~/keycloak-26.4.7
bin/kc.sh start-dev \
  --db=postgres \
  --db-url="jdbc:postgresql://localhost:5432/keycloak" \
  --db-username=keycloak_admin \
  --db-password='<KEYCLOAK_DB_PASSWORD>'

# nginx
sudo systemctl start nginx

# p3dx-aaa (systemd)
sudo systemctl start p3dx-aaa-auth-backend.service
sudo systemctl status p3dx-aaa-auth-backend.service

# APD (manual)
cd ~/p3dx-apd
go build -o /tmp/p3dx-apd ./cmd/server/main.go
set -a && source .env && set +a
/tmp/p3dx-apd &

# TOP (manual)
cd ~/Top
go build -o /tmp/top-server .
set -a && source .env && set +a
/tmp/top-server &
```

---

## 16) Security / handover notes

- Credentials in this document are current working values — rotate for production.
- Avoid exposing Keycloak/immuDB/APD/TOP publicly; use SSH forwarding for admin access.
- `TOP_BACKEND_API_KEY` and `CONTRACT_SERVER_SECRET` must match between p3dx-aaa and TOP.
- Spider data endpoints (`/run-history`, `/agent-history`, `/chat-history`) have no auth — ensure nginx or network firewall restricts external access if needed.
- immuDB is append-only; stored records cannot be modified or deleted.
- Consider a secrets manager for production credential storage.

---

## 17) systemd unit files

Templates live under `systemd/` in the repo:

- `systemd/keycloak-dev.service`
- `systemd/immudb-container.service`
- `systemd/p3dx-aaa-auth-backend.service`

Notes:
- This VM uses Docker installed via snap — Docker CLI is `/snap/bin/docker`, daemon service is `snap.docker.dockerd.service`.
- `immudb-container.service` wraps Docker commands with `/bin/bash -lc` (systemd does not interpret pipes).

### 17.1 Install unit files

```bash
sudo cp systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
```

> Ensure `WorkingDirectory`, `EnvironmentFile`, and `ExecStart` in `p3dx-aaa-auth-backend.service` point to `~/p3dx-aaa-local` before installing.

### 17.2 Enable and start all on boot

```bash
sudo systemctl enable --now immudb-container.service
sudo systemctl enable --now keycloak-dev.service
sudo systemctl enable --now p3dx-aaa-auth-backend.service
```

### 17.3 Other systemd commands

```bash
# Start without enabling
sudo systemctl start <service>

# Stop
sudo systemctl stop <service>

# Disable and stop
sudo systemctl disable --now <service>

# Logs
sudo journalctl -u p3dx-aaa-auth-backend.service -f
```

---

## 18) SSH port forwarding from macOS

Add to `~/.ssh/config`:

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

Auto-reconnect tunnel:

```bash
autossh -M 0 -N p3dx-auth-vm
```

---

## Appendix A) immuDB service API reference

**File:** `src/services/immudb.service.js`

| Function | Purpose | Call site |
|----------|---------|-----------|
| `initImmuDB()` | Connect + select DB at startup | `src/server.js` |
| `logAuditEvent(type, subjectId, metadata)` | Write auth audit event | Routes (register, login, etc.) |
| `storeWorkloadContract({contract, datasetId, applicationId, user, metadata})` | Store signed contract | `POST /workloads/run` |
| `getWorkloadContractById(contractId)` | Retrieve contract by ID | `GET /workloads/contracts/:id` |
| `storeMaaTokens({keycloakToken, userId, maaTokens, metadata})` | Store MAA attestation tokens | `POST /maa-tokens` |
| `storeRunHistory(record)` | Store Spider run record | `POST /run-history` |
| `storeAgentHistory(record)` | Store Spider agent analysis | `POST /agent-history` |
| `storeChatHistory(record)` | Store Spider chat message | `POST /chat-history` |
| `getAllAuditEvents()` | Scan all `audit:` primary keys | verify-audit.js |
| `getAuditEventsByType(eventType)` | Scan `audit:type:{eventType}:` | — |
| `getAuditEventsBySubject(subjectId)` | Scan `audit:subject:{subjectId}:` | — |

---

## Appendix B) Endpoint inventory (full POC)

### p3dx-aaa (Express, port 3001) — mounted at both `/p3dx/*` and `/anon/*`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/register` | — | Register user |
| `POST` | `/login` | — | Login (ROPC) |
| `GET` | `/login` | — | Redirect to React login page |
| `GET` | `/me` | JWT+user | Profile + roles |
| `POST` | `/workloads/run` | JWT+user | Trigger contract pipeline via TOP |
| `GET` | `/workloads/contracts/:contractId` | JWT+user | Fetch contract from immuDB |
| `GET` | `/workloads/contracts/:contractId/result` | JWT+user | Fetch signed contract from TOP |
| `POST` | `/workloads/contracts/:contractId/token-verify` | X-API-Key | Legacy TOP→backend token check |
| `GET` | `/apps/:appId/compose-url` | X-API-Key | TOP→backend compose URL lookup |
| `POST` | `/policy` | JWT+data-provider | Proxy policy to APD |
| `POST` | `/maa-tokens` | JWT+user | Store MAA tokens |
| `POST` | `/run-history` | — | Store Spider run record |
| `POST` | `/agent-history` | — | Store Spider agent record |
| `POST` | `/chat-history` | — | Store Spider chat record |
| `POST` | `/role-requests` | JWT+user | Create role request |
| `GET` | `/role-requests/my` | JWT+user/admin | List own role requests |
| `GET` | `/admin/role-requests` | JWT+admin | List all role requests |
| `POST` | `/admin/role-requests/:id/decision` | JWT+admin | Approve/reject role request |

### TOP (Go, port 8085)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/workload` | Primary — full 11-step contract pipeline |
| `POST` | `/contract` | Legacy — orchestrator signing only (steps 5–11) |
| `GET` | `/contracts/:contractId` | Return stored signed contract JSON |

### APD (Go, port 8082)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/health` | — | Health check |
| `POST` | `/api/v1/policy` | — | Store policy (from ConMan/UI) |
| `GET` | `/api/v1/policy/{policyId}` | — | Fetch policy by ID |
| `GET` | `/api/v1/policy/by-item/{itemId}` | — | Fetch policy by dataset ID (used by TOP step 5) |
| `GET` | `/api/v1/consent/{token}/approve` | — | Provider approves via one-time link |
| `GET` | `/api/v1/consent/{token}/deny` | — | Provider denies consent |
| `POST` | `/api/v1/tee/attestation` | — | TEE submits attestation report |
| `POST` | `/api/v1/tee/result` | — | TEE submits encrypted result |
| `POST` | `/api/v1/access-requests` | JWT+consumer | Create access request |
| `GET` | `/api/v1/access-requests` | JWT+consumer | List own requests |
| `GET` | `/api/v1/access-requests/{id}` | JWT | Get request |
| `POST` | `/api/v1/access-requests/{id}/compute` | JWT+consumer | Trigger TEE provisioning |
| `GET` | `/api/v1/access-requests/{id}/result` | JWT+consumer | Poll for encrypted result |
| `POST` | `/api/v1/access-requests/{id}/key-bundle` | JWT+provider | Submit encrypted key bundle |
| `GET` | `/api/v1/provider/access-requests` | JWT+provider | List assigned requests |

### p3dx-auth-ui (React SPA) — client-side routes

| Path | Description |
|------|-------------|
| `/login` | Login page |
| `/register` | Registration page |
| `/app/services` | Services landing |
| `/app/services/run` | Run Workload form |
| `/app/services/run/:contractId` | Workload result (TEE started + signed contract) |
| `/app/services/policies` | Policy submission form (data-provider only) |
| `/app/admin` | Admin role request dashboard |
