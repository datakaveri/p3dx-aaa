// In-memory relay for `terraform/participant-vm/deploy.sh` progress.
//
// deploy.sh runs on a participant's (data provider or output owner) own
// machine against their own Azure subscription — this backend never touches
// their Azure credentials. It only relays "here's what deploy.sh is doing
// right now" back to that participant's FL dashboard so they can watch VM
// creation happen without staring at a terminal. Sessions are short-lived and
// held in memory only; a backend restart simply drops in-flight status (the
// VM itself is unaffected — it's owned by the participant's Terraform state,
// not by this process).

import crypto from 'node:crypto';

const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2h — comfortably covers init+plan+apply

const sessions = new Map(); // token -> { username, role, status, events: [], createdAt }

function dropExpired() {
  const cutoff = Date.now() - TOKEN_TTL_MS;
  for (const [token, session] of sessions) {
    if (session.createdAt < cutoff) sessions.delete(token);
  }
}

// Mints a token identifying which logged-in user a later deploy.sh run
// belongs to. Handed to the participant once (over an authenticated
// request); deploy.sh then uses it in place of a JWT it has no way to hold.
export function createProvisioningToken({ username, role }) {
  dropExpired();
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, role, status: 'idle', events: [], createdAt: Date.now() });
  return token;
}

// Records one deploy.sh step. status is one of "running" | "ok" | "error" |
// "done" — deploy.sh decides which, this just relays it.
export function appendProvisioningEvent({ token, step, command, status, message }) {
  const session = sessions.get(token);
  if (!session) return null;
  session.events.push({ step, command, status, message, at: new Date().toISOString() });
  session.status = status === 'error' ? 'error' : status === 'done' ? 'done' : 'running';
  return session;
}

// Most recent provisioning session for this username+role, if any — the FL
// page polls this (via the SSE stream) to render live progress. A single
// participant can hold sessions for both roles at once (a data-provider VM
// and a user VM), so role must be part of the filter or one role's panel can
// end up showing the other role's VM.
export function getProvisioningStatusForUser(username, role) {
  let latest = null;
  for (const session of sessions.values()) {
    if (session.username === username && session.role === role && (!latest || session.createdAt > latest.createdAt)) {
      latest = session;
    }
  }
  return latest;
}
