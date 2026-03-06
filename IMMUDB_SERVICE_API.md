# ImmuDB Service API Reference

## Overview
`src/services/immudb.service.js` provides audit logging functionality using ImmuDB for immutable event storage.

---

## Exported Functions

### 1. `initImmuDB()`
**Purpose:** Initialize connection to ImmuDB server at application startup

**Signature:**
```javascript
export async function initImmuDB()
```

**Parameters:** None

**Returns:** `void` (Promise)

**Behavior:**
- Reads env variables: `IMMUDB_HOST`, `IMMUDB_PORT`, `IMMUDB_USER`, `IMMUDB_PASSWORD`, `IMMUDB_DATABASE`
- Connects to ImmuDB server
- Selects the specified database
- Falls back to console-only logging if DB unavailable
- Logs connection status to console

**Usage:**
```javascript
import { initImmuDB } from './services/immudb.service.js';
await initImmuDB();  // Called in server.js before app.listen()
```

---

### 2. `logAuditEvent(eventType, subjectId, metadata = {})`
**Purpose:** Record an audit event with immutable storage

**Signature:**
```javascript
export async function logAuditEvent(eventType, subjectId, metadata = {})
```

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `eventType` | `string` | Event type (e.g. `USER_LOGIN_SUCCESS`, `USER_REGISTER_FAILED`) |
| `subjectId` | `string` | User/subject identifier (username, user ID, or 'unknown') |
| `metadata` | `object` | Additional event data (IP, user-agent, error details, etc.) |

**Returns:** `object` - The event object that was logged (or `null` if DB not initialized)

**Storage Strategy:**
Events are stored with multiple indexed keys for flexible querying:
- `audit:<eventId>` - Primary key
- `audit:type:<eventType>:<eventId>` - Event type index
- `audit:subject:<subjectId>:<eventId>` - Subject index
- `audit:time:<timestamp>:<eventId>` - Timestamp index

**Usage:**
```javascript
await logAuditEvent('USER_LOGIN_SUCCESS', 'john_doe', {
  ip: '192.168.1.1',
  userAgent: 'Mozilla/5.0...',
  timestamp: new Date().toISOString(),
  tokenExpiresIn: 300
});
```

**Event Structure Stored:**
```json
{
  "event_id": "550e8400-e29b-41d4-a716-446655440000",
  "event_type": "USER_LOGIN_SUCCESS",
  "subject_id": "john_doe",
  "timestamp": 1708976400000,
  "occurred_at": "2026-02-26T10:30:00.000Z",
  "metadata": {
    "ip": "192.168.1.1",
    "userAgent": "Mozilla/5.0...",
    "timestamp": "2026-02-26T10:30:00.000Z",
    "tokenExpiresIn": 300
  }
}
```

---

### 3. `getAllAuditEvents()`
**Purpose:** Retrieve all audit events from the database

**Signature:**
```javascript
export async function getAllAuditEvents()
```

**Parameters:** None

**Returns:** `array` - Array of parsed audit event objects (empty array if no events or DB error)

**Behavior:**
- Scans all keys with prefix `audit:`
- Filters to primary keys only (format: `audit:<uuid>`)
- Parses JSON values
- Handles pagination internally via `scanAllByPrefix()`

**Usage:**
```javascript
const allEvents = await getAllAuditEvents();
console.log(allEvents);  // Array of event objects
```

---

### 4. `getAuditEventsByType(eventType)`
**Purpose:** Retrieve audit events filtered by type

**Signature:**
```javascript
export async function getAuditEventsByType(eventType)
```

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `eventType` | `string` | Event type to filter by (e.g. `USER_LOGIN_SUCCESS`) |

**Returns:** `array` - Array of matching audit event objects (empty array if none found or DB error)

**Behavior:**
- Scans keys with prefix `audit:type:<eventType>:`
- Parses values
- Returns all events matching the type

**Usage:**
```javascript
const loginEvents = await getAuditEventsByType('USER_LOGIN_SUCCESS');
const failedRegistrations = await getAuditEventsByType('USER_REGISTER_FAILED');
```

---

### 5. `scanAllByPrefix(prefix)` (Internal)
**Purpose:** Internal utility to paginate through ImmuDB scan results

**Signature:**
```javascript
async function scanAllByPrefix(prefix)
```

**Parameters:**
| Parameter | Type | Description |
|-----------|------|-------------|
| `prefix` | `string` | Key prefix to scan (e.g. `audit:`) |

**Returns:** `array` - Array of ImmuDB entries with `key` and `value` properties

**Note:** This is an internal helper, not exported for external use.

---

## Event Types Used in Router

| Event Type | When Fired | Subject |
|------------|-----------|---------|
| `USER_REGISTER_SUCCESS` | Successful user registration | username |
| `USER_REGISTER_FAILED` | Missing fields during registration | username or 'unknown' |
| `USERNAME_ALREADY_EXISTS` | Duplicate username (409 error) | username or 'unknown' |
| `USER_REGISTER_ERROR` | Unexpected error during registration | username or 'unknown' |
| `USER_LOGIN_SUCCESS` | Successful user login | username |
| `USER_LOGIN_FAILED` | Failed login attempt (invalid credentials) | username or 'unknown' |
| `USER_PROFILE_ACCESS` | User accesses `/me` endpoint | username |
| `JWT_VERIFY_FAILED` | JWT token validation failure | 'unknown' |

---

## Environment Variables Required

```
IMMUDB_HOST=127.0.0.1
IMMUDB_PORT=3322
IMMUDB_USER=anon_backend
IMMUDB_PASSWORD=<YOUR_IMMUDB_PASSWORD>
IMMUDB_DATABASE=anon_audit
```

---

## Error Handling

- If ImmuDB is not configured or unavailable, all functions fall back to **console-only logging**
- `logAuditEvent()` will **not throw errors** - it logs failures and continues
- Retrieval functions return empty arrays on error (safe fallback)
- Database selection errors are caught and logged to console

---

## Example Workflow

```javascript
import { initImmuDB, logAuditEvent, getAllAuditEvents } from './services/immudb.service.js';

// 1. Initialize at startup
await initImmuDB();

// 2. Log events throughout application
await logAuditEvent('USER_LOGIN_SUCCESS', 'alice', {
  ip: '10.0.0.1',
  timestamp: new Date().toISOString()
});

// 3. Retrieve events anytime
const allEvents = await getAllAuditEvents();
const loginEvents = await getAuditEventsByType('USER_LOGIN_SUCCESS');
```
