import { differenceInSeconds } from "date-fns";

export function formatTimeAgo(date: Date): string {
  const seconds = differenceInSeconds(new Date(), date);

  if (seconds < 60) return "<1m";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 604800)}w ago`;
  if (seconds < 31536000) return `${Math.floor(seconds / 2592000)}mo ago`;
  return `${Math.floor(seconds / 31536000)}y ago`;
}

/**
 * Convert a server-provided timestamp (ISO string, Date, null, or undefined)
 * into a finite epoch-ms number, or `null` if the value is missing/unparseable.
 *
 * Used to lift server-side "started at" timestamps into the live-elapsed-timer
 * pipeline so the chronometer survives page refreshes instead of restarting
 * from `Date.now()` on every mount.
 */
export function toEpochMs(
  value: string | Date | null | undefined,
): number | null {
  if (value == null || value === "") return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Format a duration in seconds into a human-readable string.
 * - Under 60s: "12.3s"
 * - 60s and above: "2m 3.1s"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  // Round the remainder first to avoid ".toFixed(1)" pushing 59.95 → "60.0"
  const remainder = Math.round((seconds % 60) * 10) / 10;
  const carry = remainder >= 60 ? 1 : 0;
  const mins = Math.floor(seconds / 60) + carry;
  const secs = carry ? 0 : remainder;
  return `${mins}m ${secs.toFixed(1)}s`;
}
