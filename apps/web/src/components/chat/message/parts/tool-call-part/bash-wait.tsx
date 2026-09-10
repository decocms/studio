import { useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import { useClockTick } from "@/lib/use-clock-tick.ts";

const STORAGE_KEY = "studio:bash-sleep-start:v1";

/** LRU cap. A long session runs many `bash` calls; bounds sessionStorage growth. */
const MAX_ENTRIES = 200;

type StoredEntry = [toolCallId: string, startedAtMs: number];

/**
 * LRU upsert of `toolCallId`, evicting the oldest entries past `cap`. Pure —
 * takes and returns the entry list, same shape as `thread-layout-memory`'s.
 */
export function upsertCallStartEntries(
  entries: StoredEntry[],
  toolCallId: string,
  startedAtMs: number,
  cap: number = MAX_ENTRIES,
): StoredEntry[] {
  const next = entries.filter(([id]) => id !== toolCallId);
  next.push([toolCallId, startedAtMs]);
  while (next.length > cap) next.shift();
  return next;
}

function readEntries(): StoredEntry[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is StoredEntry =>
        Array.isArray(e) &&
        e.length === 2 &&
        typeof e[0] === "string" &&
        Number.isFinite(e[1]),
    );
  } catch {
    return [];
  }
}

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
  try {
    const entries = readEntries();
    const existing = entries.find(([id]) => id === toolCallId);
    if (existing) return existing[1];
    const now = Date.now();
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(upsertCallStartEntries(entries, toolCallId, now)),
    );
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
function useCallStartedAt(toolCallId: string, anchorMs: number | null): number {
  const fallback = useState(() => firstSeenStart(toolCallId))[0];
  return anchorMs ?? fallback;
}

function formatDuration(ms: number): string {
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
  const startedAt = useCallStartedAt(toolCallId, anchorMs);
  const remaining = startedAt + durationMs - Date.now();
  return (
    <span className="tabular-nums">
      {remaining > 0 ? `Waiting ${formatDuration(remaining)}` : "Wrapping up…"}
    </span>
  );
}

/**
 * Below this, a running tool is just latency and a counter is noise. Past it,
 * the run looks frozen without one.
 */
const ELAPSED_VISIBLE_AFTER_MS = 10_000;

/**
 * Live "running for Ns" readout for any still-running tool call.
 *
 * The sibling countdown above needs a known duration; this one does not, which
 * is what makes it usable for the calls that actually read as a hang — a
 * multi-minute `deno test`, a build, an MCP tool waiting on a deploy. Anchored
 * the same way (`anchorMs`, else the sessionStorage-backed first-observed time)
 * so a reload keeps counting from when the call really fired.
 *
 * Under `ELAPSED_VISIBLE_AFTER_MS` it renders the plain "Preparing…" copy: a
 * counter on every fast tool call would be worse than no counter at all.
 */
export function ToolElapsedSummary({
  toolCallId,
  anchorMs,
}: {
  toolCallId: string;
  anchorMs: number | null;
}) {
  const t = useT();
  useClockTick(1000);
  const startedAt = useCallStartedAt(toolCallId, anchorMs);
  const elapsed = Date.now() - startedAt;
  if (elapsed < ELAPSED_VISIBLE_AFTER_MS) return t("chat.generic.preparing");
  return (
    <span className="tabular-nums">
      {t("chat.generic.runningFor", { elapsed: formatDuration(elapsed) })}
    </span>
  );
}
