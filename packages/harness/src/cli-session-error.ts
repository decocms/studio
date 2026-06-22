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

// Patterns verified against the Codex provider: /thread.*not found/i and
// /not found after server restart/i. The claude-code patterns
// (/no conversation found/i and /session.*not found/i) are best-effort —
// they have NOT been verified against the native `claude --resume` binary's
// actual stale-session stderr and may need adjustment once a real stale
// resume output is captured.
const STALE_PATTERNS = [
  /thread.*not found/i,
  /not found after server restart/i,
  /no conversation found/i,
  /session.*not found/i,
];

/** Extract string fields from an unknown value for stale-session detection. */
function collectHaystrings(value: unknown): string[] {
  const parts: string[] = [];
  if (typeof value === "string") {
    parts.push(value);
    return parts;
  }
  if (value == null || typeof value !== "object") return parts;
  const obj = value as Record<string, unknown>;
  if (typeof obj["message"] === "string") parts.push(obj["message"]);
  if (typeof obj["stderr"] === "string") parts.push(obj["stderr"]);
  if (obj["data"] != null) {
    parts.push(...collectHaystrings(obj["data"]));
  }
  return parts;
}

/** True when an error indicates a missing/stale resumable session/thread. */
export function isStaleSessionError(err: unknown): boolean {
  const haystrings = collectHaystrings(err);

  // One level deep into cause (no unbounded recursion)
  if (err != null && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (obj["cause"] != null) {
      haystrings.push(...collectHaystrings(obj["cause"]));
    }
  }

  const haystack = haystrings.join("\n");
  if (!haystack) return false;
  return STALE_PATTERNS.some((re) => re.test(haystack));
}
