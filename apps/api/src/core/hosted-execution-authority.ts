import type { Thread } from "@/storage/types";

/**
 * Hosted execution is authorized by selector-free persisted state. A pristine
 * draft is eligible to be claimed but cannot execute yet; a tombstoned legacy
 * row stays fail-closed even though its history remains readable.
 */
export function hasHostedExecutionAuthority(
  thread:
    | Pick<Thread, "routing_locked_at" | "hosted_execution_disabled_at">
    | null
    | undefined,
): boolean {
  return (
    thread != null &&
    thread.routing_locked_at !== null &&
    thread.hosted_execution_disabled_at === null
  );
}
