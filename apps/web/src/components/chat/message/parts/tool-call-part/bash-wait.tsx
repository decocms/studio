import { useState } from "react";
import { useClockTick } from "@/lib/use-clock-tick.ts";

const STORAGE_PREFIX = "bash-sleep-start:";

/**
 * First-observed fire time (epoch ms) for a bash `sleep`, keyed by toolCallId
 * and persisted to `sessionStorage`. This is the fallback when the part has no
 * server-stamped `created_at` (v1 threads, or an in-flight turn whose parts
 * aren't folded from storage yet) — without persistence the anchor would reset
 * to "now" on every page refresh and restart the countdown. The toolCallId is
 * stable across refresh, so the original observation is recovered. Returns
 * `Date.now()` (and records it) the first time a given call is seen.
 */
function firstSeenStart(toolCallId: string): number {
  const key = STORAGE_PREFIX + toolCallId;
  try {
    const stored = sessionStorage.getItem(key);
    if (stored !== null) {
      const parsed = Number.parseInt(stored, 10);
      if (Number.isFinite(parsed)) return parsed;
    }
    const now = Date.now();
    sessionStorage.setItem(key, String(now));
    return now;
  } catch {
    // sessionStorage unavailable (SSR / privacy mode): best-effort, non-sticky.
    return Date.now();
  }
}

/**
 * Resolve the countdown anchor. Prefer `anchorMs` — the part's own server-
 * stamped `created_at` (v2), accurate across any client. Otherwise fall back to
 * the first time this browser observed the call running, persisted in
 * sessionStorage so it survives a page refresh instead of resetting.
 */
function useSleepStartedAt(
  toolCallId: string,
  anchorMs: number | null,
): number {
  const fallback = useState(() => firstSeenStart(toolCallId))[0];
  return anchorMs ?? fallback;
}

function formatCountdown(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

/**
 * Live "waiting on `sleep`" hint for a still-running `bash` tool call.
 *
 * Anchored on the call's fire time (`anchorMs`, else the sessionStorage-backed
 * first-observed time) so a reloaded / late-attaching client counts down from
 * real elapsed time rather than restarting. Once the window elapses we show
 * "wrapping up" instead of a negative number; the row flips to its result the
 * moment the tool returns. Ticks once per second via the shared clock store.
 */
export function BashWaitSummary({
  toolCallId,
  durationMs,
  anchorMs,
}: {
  toolCallId: string;
  durationMs: number;
  anchorMs: number | null;
}) {
  useClockTick(1000);
  const startedAt = useSleepStartedAt(toolCallId, anchorMs);
  const remaining = startedAt + durationMs - Date.now();
  return (
    <span className="tabular-nums">
      {remaining > 0 ? `Waiting ${formatCountdown(remaining)}` : "Wrapping up…"}
    </span>
  );
}
