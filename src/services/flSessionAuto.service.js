// Automatically starts the actual FL training session once the output-owner's
// server VM is up AND every provider selected for that submission has
// connected their client - closing the gap where nothing in this platform
// ever called flo_server.py's POST /execute_command; that used to be a
// manual SSH step (see terraform/participant-vm/outputs.tf's
// session_status_hint).
//
// Readiness is judged by *count* (connected clients >= selected providers),
// not identity - flo_server's /client_status keys clients by whatever
// CLIENT_NAME each provider's VM was given (see cloud-init.sh.tftpl), which
// is an arbitrary name they typed, not their platform username, so there's
// no reliable identity to match against without deeper client-side changes.
//
// Progress is surfaced by piggybacking on the *existing* VM-provisioning SSE
// plumbing (appendProvisioningEvent) rather than adding a new stream: every
// provisioning token associated with this submission (the owner's VM run,
// plus each provider's VM run) gets the same "Waiting for clients"/"Starting
// FL session" events appended, so both FL_Orchestrator.jsx and
// FlOrchestrator.jsx's already-mounted VmProvisioningPanel show it with zero
// frontend plumbing beyond passing submissionId through (see those files).
import axios from 'axios';
import { flotillaQuicksetupConfig } from '../config/flotillaQuicksetupConfig.js';
import { appendProvisioningEvent } from './vmProvisioning.service.js';

const FL_SERVER_PORT = 12345;
const POLL_MS = 5000;
const MAX_WAIT_MS = 2 * 60 * 60 * 1000; // give up after 2h of not everyone connecting

const submissions = new Map(); // submissionId -> state (see getOrCreate)

function getOrCreate(submissionId) {
  let s = submissions.get(submissionId);
  if (!s) {
    s = {
      expectedProviderCount: null,
      ownerIp: null,
      tokens: new Set(),
      lastConnectedCount: -1,
      started: false,
      pollTimer: null,
      pollStartedAt: null,
    };
    submissions.set(submissionId, s);
  }
  return s;
}

function emit(s, event) {
  for (const token of s.tokens) appendProvisioningEvent({ token, ...event });
}

// Called from POST /gov/start-fl-session, which already knows the full
// participating_providers list for this submission.
export function registerExpectedProviders(submissionId, count) {
  if (!submissionId || !count) return;
  const s = getOrCreate(submissionId);
  s.expectedProviderCount = count;
  maybeStartPolling(submissionId);
}

// Called once a provider's own VM auto-create run has a token, so they get
// the fan-out events on their panel too.
export function registerProviderToken(submissionId, token) {
  if (!submissionId || !token) return;
  getOrCreate(submissionId).tokens.add(token);
}

// Called once the owner's ("user" role) VM run succeeds and its public IP is
// known - that VM is the one running flo_server.py.
export function registerOwnerVm(submissionId, ip, token) {
  if (!submissionId || !ip) return;
  const s = getOrCreate(submissionId);
  s.ownerIp = ip;
  if (token) s.tokens.add(token);
  maybeStartPolling(submissionId);
}

function maybeStartPolling(submissionId) {
  const s = submissions.get(submissionId);
  if (!s || s.pollTimer || s.started) return;
  if (!s.ownerIp || !s.expectedProviderCount) return; // need both sides before there's anything to poll

  s.pollStartedAt = Date.now();
  emit(s, { step: 'Waiting for clients', status: 'running', message: `0/${s.expectedProviderCount} providers connected` });
  s.pollTimer = setInterval(() => pollOnce(submissionId), POLL_MS);
  pollOnce(submissionId);
}

async function pollOnce(submissionId) {
  const s = submissions.get(submissionId);
  if (!s || s.started) return;

  if (Date.now() - s.pollStartedAt > MAX_WAIT_MS) {
    clearInterval(s.pollTimer);
    s.pollTimer = null;
    emit(s, {
      step: 'Waiting for clients', status: 'error',
      message: `Gave up after 2h — not all ${s.expectedProviderCount} provider(s) connected. Start the session manually over SSH once they do.`,
    });
    return;
  }

  let count;
  try {
    const { data } = await axios.get(`http://${s.ownerIp}:${FL_SERVER_PORT}/client_status`, { timeout: 5000 });
    count = Object.keys(data?.clients || {}).length;
  } catch {
    return; // server VM likely still booting/pulling images - not worth surfacing every 5s
  }

  if (count !== s.lastConnectedCount) {
    s.lastConnectedCount = count;
    emit(s, { step: 'Waiting for clients', status: 'running', message: `${count}/${s.expectedProviderCount} providers connected` });
  }

  if (count >= s.expectedProviderCount) {
    clearInterval(s.pollTimer);
    s.pollTimer = null;
    s.started = true;
    startSession(submissionId, s);
  }
}

function startSession(submissionId, s) {
  emit(s, { step: 'Starting FL session', status: 'running', message: 'All expected providers connected — starting training' });

  const sessionId = String(submissionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const body = {
    federated_learning_config: flotillaQuicksetupConfig,
    session_id: sessionId,
    file: false,
    restore: false,
    revive: false,
  };

  // POST /execute_command blocks server-side until the whole training run
  // finishes (could be a long time) - fire it and move on instead of
  // awaiting it inline; its eventual resolution/rejection becomes one more
  // event for whoever's still watching this submission's panels.
  axios.post(`http://${s.ownerIp}:${FL_SERVER_PORT}/execute_command`, body, { timeout: 0 })
    .then((res) => {
      emit(s, { step: 'FL session', status: 'done', message: res?.data?.message || `Session ${sessionId} finished` });
    })
    .catch((err) => {
      emit(s, { step: 'FL session', status: 'error', message: err?.response?.data?.message || err.message });
    });

  emit(s, { step: 'Starting FL session', status: 'ok', message: `Session ${sessionId} started — training is now running on the server VM` });
}
