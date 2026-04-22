# p3dx-aaa

Authentication and audit backend for the P3DX platform, built with Node.js and Express.

Integrates with **Keycloak** for identity management and **immuDB** for tamper-evident audit logging. Also handles workload orchestration via TOP, policy submission proxying to APD, and role request workflows.

---

## What this repo does

- User registration and login via Keycloak (OIDC / ROPC flow)
- JWT verification and role-based access control on all protected endpoints
- Tamper-evident audit logging to immuDB for every login, registration, and workload event
- Workload execution — forwards raw workload parameters (`access_token`, `dataset_id`, `application_id`) to TOP, which owns the full contract lifecycle (creation → consumer signing → policy check → orchestrator signing → TEE deployment)
- Signed contract storage — stores the fully signed contract returned by TOP in immuDB
- Policy submission proxying to APD (Access Policy Database)
- Admin role request approval workflow

Both `/p3dx/*` and `/anon/*` path prefixes are supported and route to the same handlers.

---

## Getting Started

### Prerequisites

- Node.js v18+
- Keycloak running and configured (see Setup.md §5–7)
- immuDB running (see Setup.md §8)
- TOP running and reachable (see Setup.md for TOP configuration)

### Install

```bash
git clone <repo-url>
cd p3dx-aaa
npm install
```

### Configure

```bash
cp .env.example .env
# Fill in Keycloak, immuDB, and contract settings
```

### Provision immuDB (first run only)

```bash
npm run setup:immudb
```

### Start

```bash
npm start
```

Expected output:
```
✓ immuDB connected and database selected
p3dx-aaa auth backend running on port 3001
```

Use `npm run dev` for auto-reload during development.

---

## API Endpoints

### Auth

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/p3dx/register` | None | Register a new user |
| `GET` | `/p3dx/login` | None | Redirect to login page (browser flow) |
| `POST` | `/p3dx/login` | None | Authenticate — returns `access_token`, `refresh_token`, `expires_in` |
| `GET` | `/p3dx/me` | Bearer + `user` or `admin` | Current user profile and roles |

### Workloads

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/p3dx/workloads/run` | Bearer + `user` | Forward raw workload params to TOP; store returned signed contract in immuDB |
| `GET` | `/p3dx/workloads/contracts/:contractId` | Bearer + `user` | Retrieve contract record from immuDB |
| `GET` | `/p3dx/workloads/contracts/:contractId/result` | Bearer + `user` | Fetch final signed contract from TOP |
| `POST` | `/p3dx/workloads/contracts/:contractId/token-verify` | `X-API-Key` | TOP→Backend: verify user token fingerprint (legacy — not called in current flow) |
| `GET` | `/p3dx/apps/:appId/compose-url` | `X-API-Key` | TOP→Backend: resolve app to docker-compose URL |

### Policies & Roles

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/p3dx/policy` | Bearer + `data-provider` | Submit dataset access policy (proxied to APD) |
| `POST` | `/p3dx/maa-tokens` | Bearer + `user` | Store MAA attestation tokens |
| `POST` | `/p3dx/role-requests` | Bearer + `user` | Request a role |
| `GET` | `/p3dx/role-requests/my` | Bearer + `user` or `admin` | List own role requests |
| `GET` | `/p3dx/admin/role-requests` | Bearer + `admin` | List all role requests |
| `POST` | `/p3dx/admin/role-requests/:id/decision` | Bearer + `admin` | Approve or deny a role request |

---

## Scripts

| Script | Description |
|---|---|
| `npm start` | Start the backend |
| `npm run dev` | Start with auto-reload |
| `npm run setup:immudb` | Provision immuDB database and user (run once) |
| `npm run diagnose:immudb` | Test immuDB connectivity |
| `npm run test:e2e` | Register → login → profile (basic auth flow) |
| `npm run test:workload` | Run workload → verify contract stored → fetch signed result |
| `npm run test:policy` | Submit dataset policy via data-provider user (requires APD) |
| `npm run test:role-requests` | Full role request workflow — user requests, admin approves |
| `npm run test:maa` | MAA token submission |
| `npm run test:immudb` | Full audit flow — verifies all events are persisted in immuDB |
| `npm run test:audit` | Print stored audit events |

---

## Production

In production, nginx sits in front and serves the Auth UI (React SPA) alongside this backend:

- `GET /login`, `/app`, … → static Auth UI (`p3dx-auth-ui/dist/`)
- `/anon/*`, `/p3dx/*` → proxied to this backend on port 3001

The backend runs under systemd (`p3dx-aaa-auth-backend.service`). See Setup.md §9.6–9.7 for nginx and UI setup, and §17 for systemd unit configuration.

---

## More Information

See **Setup.md** for the full setup guide — Keycloak, PostgreSQL, immuDB, APD, TOP integration, environment variable reference, and troubleshooting.
