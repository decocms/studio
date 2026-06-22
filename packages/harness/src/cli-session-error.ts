/**
 * Thrown when a CLI harness cannot resume its on-disk session (e.g. the
 * desktop daemon was restarted and the rollout is gone). Surfaced to the
 * user as a turn error; there is no replay/fallback by design.
 */
export class CliSessionExpiredError extends Error {
  constructor(cause?: unknown) {
    super("Session expired — start a new thread.", { cause });
    this.name = "CliSessionExpiredError";
  }
}

const STALE_PATTERNS = [
  /thread.*not found/i,
  /not found after server restart/i,
  /no conversation found/i,
  /session.*not found/i,
];

/** True when an error indicates a missing/stale resumable session/thread. */
export function isStaleSessionError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!message) return false;
  return STALE_PATTERNS.some((re) => re.test(message));
}
