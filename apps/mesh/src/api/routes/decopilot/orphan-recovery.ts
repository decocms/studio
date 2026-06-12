import type { Thread } from "@/storage/types";

/**
 * Only hosted runs may be recovered by calling dispatchRunAndWait in the API
 * process. User-desktop runs are owned by the DBOS thread gate + pull transport;
 * replaying them here loses the pre-resolved desktop target and can start the
 * Decopilot harness in the API process.
 */
export function shouldResumeThreadInProcess(
  thread: Pick<Thread, "sandbox_provider_kind">,
): boolean {
  return thread.sandbox_provider_kind !== "user-desktop";
}
