/**
 * Wake-up nudge for the org-fs change feed.
 *
 * The mount invalidator (daemon side) long-polls `/api/:org/fs/:volume/changes`
 * to learn about external writes. Rather than poll on a timer, the server holds
 * each request open and publishes a per-(org, volume) NATS notify on every
 * write, waking the long-poll instantly. This is the same NatsNotify +
 * poll-timeout safety-net pattern the event bus uses.
 *
 * The payload is intentionally empty: the daemon re-queries the change feed on
 * wake, so a nudge only needs to signal "something changed for this volume".
 */

import type { NatsConnection } from "@nats-io/nats-core";

const SUBJECT_PREFIXES = [
  "studio.org-fs.changes",
  "mesh.org-fs.changes",
] as const;

/**
 * Canonical subject plus the legacy alias used during rolling upgrades, or []
 * if either token contains a character that isn't safe in a subject (`.`,
 * `*`, `>`, ws). Volume is already validated upstream; orgId is
 * server-controlled — the guard is defensive, and empty subjects just mean
 * the long-poll falls back to its timeout safety net.
 */
export function orgFsChangeSubjects(orgId: string, volume: string): string[] {
  if (/[.*>\s]/.test(orgId) || /[.*>\s]/.test(volume)) return [];
  return SUBJECT_PREFIXES.map((prefix) => `${prefix}.${orgId}.${volume}`);
}

/**
 * Best-effort wake-up after a write. Never throws — if NATS is down the
 * daemon's long-poll timeout still picks the change up on its next cycle.
 */
export function notifyOrgFsChange(
  nc: NatsConnection | null,
  orgId: string,
  volume: string,
): void {
  if (!nc) return;
  const subjects = orgFsChangeSubjects(orgId, volume);
  try {
    for (const subject of subjects) nc.publish(subject);
  } catch {
    // best-effort
  }
}
