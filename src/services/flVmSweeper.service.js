import { listVmOfflineSessions, deleteOfflineSession } from './keycloak.service.js';
import defaultStore from './flVmCredentials.service.js';

/**
 * Expiry sweeper for Flotilla FL client-VM credentials.
 *
 * Walks every offline session held by the flotilla-vm Keycloak client and
 * deletes the ones that no longer have a live credential behind them:
 *   - orphans (no flvmcred:sid:<sid> record — e.g. issued outside aaa, or a
 *     record write that never happened), and
 *   - sessions whose record is past expires_at (contract valid_until) or
 *     already marked expired (e.g. a handoff failure whose delete failed).
 * Records for deleted sessions are marked `expired`. A session whose record
 * can't be read is left alone this round (store unavailable ≠ orphan).
 */
export async function sweepVmOfflineSessions({
  keycloak = { listVmOfflineSessions, deleteOfflineSession },
  store = defaultStore,
  now = () => Date.now(),
} = {}) {
  const summary = { sessions: 0, kept: 0, orphansDeleted: 0, expiredDeleted: 0, skipped: 0, errors: 0 };
  const sessions = await keycloak.listVmOfflineSessions();
  summary.sessions = sessions.length;

  for (const session of sessions) {
    const sid = session?.id;
    if (!sid) {
      summary.skipped += 1;
      continue;
    }

    let record;
    try {
      record = await store.findBySessionId(sid);
    } catch (err) {
      summary.skipped += 1;
      summary.errors += 1;
      continue;
    }

    const expiresMs = record ? Date.parse(record.expires_at) : NaN;
    const expired = record && (record.state === 'expired' || Number.isNaN(expiresMs) || now() >= expiresMs);
    if (record && !expired) {
      summary.kept += 1;
      continue;
    }

    try {
      await keycloak.deleteOfflineSession(sid);
      if (record) {
        summary.expiredDeleted += 1;
        if (record.state !== 'expired') {
          await store.setState(record.credential_id, 'expired', { reason: 'CONTRACT_EXPIRED' });
        }
      } else {
        summary.orphansDeleted += 1;
      }
    } catch (err) {
      summary.errors += 1;
    }
  }

  return summary;
}

/**
 * Start the periodic sweep (unref'd so it never holds the process open).
 * FL_VM_SWEEP_INTERVAL_MS=0 disables it. Never throws out of the timer.
 */
export function startFlVmSweeper({ intervalMs, ...deps } = {}) {
  const raw = intervalMs ?? process.env.FL_VM_SWEEP_INTERVAL_MS;
  const parsed = Number.parseInt(raw ?? '', 10);
  const ms = Number.isNaN(parsed) ? 600000 : parsed;
  if (ms <= 0) {
    console.log('[P3DX_STEP_OK] fl-vm-sweeper: disabled (FL_VM_SWEEP_INTERVAL_MS=0)');
    return null;
  }

  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const s = await sweepVmOfflineSessions(deps);
      console.log(
        `[P3DX_STEP_OK] fl-vm-sweeper: sessions=${s.sessions} kept=${s.kept} orphans_deleted=${s.orphansDeleted} expired_deleted=${s.expiredDeleted} skipped=${s.skipped} errors=${s.errors}`
      );
    } catch (err) {
      console.warn(`[P3DX_STEP_WARN] fl-vm-sweeper: sweep failed: ${err?.message || 'error'}`);
    } finally {
      running = false;
    }
  }, ms);
  timer.unref?.();
  console.log(`[P3DX_STEP_OK] fl-vm-sweeper: started (every ${ms} ms)`);
  return timer;
}
