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
    // The reason is a stringified Error, so the code sits behind "Error: ".
    return decodeSandboxStartError(reason.replace(/^Error:\s*/, ""));
  }
  return null;
}
