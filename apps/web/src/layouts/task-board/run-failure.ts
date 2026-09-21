/**
 * What the card's last run failed with, if a human can act on it.
 *
 * Run failures reach the board only as prose on the timeline: `run-reactions.ts`
 * writes the raw error text into a `status_changed` entry's `reason`. When that
 * error came from `buildCloneInfo` it still carries the wire prefix
 * (`GITHUB_NOT_AUTHENTICATED::…`), which rendered literally in the feed and
 * named no remedy — so a task wedged on a stale GitHub App installation looked
 * like a mystery, and Re-run (which works, and re-dispatches) failed the same
 * way inside a second, which looked like Re-run was broken.
 *
 * Newest entry wins and nothing else is consulted, so a later run that gets
 * further clears this by itself.
 */
import { decodeSandboxStartError } from "@decocms/shared/sandbox-start-errors";
import type { SandboxStartErrorCode } from "@decocms/shared/sandbox-start-errors";
import { LANES } from "@decocms/shared/task-board";

/**
 * The human-readable text for a single activity entry's raw `reason` string,
 * independent of whether that entry is a standing failure. Callers that
 * already know which entry they mean (e.g. rendering one timeline row) want
 * this instead of {@link lastRunFailure}, which also gates on `retry`/`to`
 * to decide banner visibility across a whole activity list.
 */
export function decodeRunFailureReason(reason: unknown): string {
  if (typeof reason !== "string") return "";
  return decodeSandboxStartError(reason.replace(/^Error:\s*/, "")).message;
}

export function lastRunFailure(
  activity: { action: string; data: Record<string, unknown> | null }[],
): { code: SandboxStartErrorCode | null; message: string } | null {
  for (let i = activity.length - 1; i >= 0; i--) {
    const entry = activity[i];
    if (!entry || entry.action !== "status_changed") continue;
    // A scheduled retry is the machine still working — not a standing failure.
    if (typeof entry.data?.retry === "number") return null;
    const reason = entry.data?.reason;
    // The newest move decides: no reason means the card got somewhere.
    if (typeof reason !== "string") return null;
    // Benign moves stamp a reason too ("pr_merged", "rerun"); only a dead run
    // lands back in the queue lane.
    if (entry.data?.to !== LANES.queue) return null;
    // The reason is a stringified Error, so the code sits behind "Error: ".
    return decodeSandboxStartError(reason.replace(/^Error:\s*/, ""));
  }
  return null;
}
