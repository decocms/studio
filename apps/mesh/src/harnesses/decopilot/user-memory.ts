/**
 * Gate for the per-user "interests" memory.
 *
 * Personal memory (identity, history, interests) is injected into the prompt
 * and writable via `update_interests` ONLY for the built-in decopilot
 * assistant, or for created agents that explicitly opt in via
 * `metadata.userMemory === true`. This keeps personal context out of
 * task-specific or published agents, where it would be noise or a leak.
 */

import { isDecopilot } from "@decocms/mesh-sdk";

export function isUserMemoryEnabled(
  agentId: string,
  metadata: unknown,
): boolean {
  if (isDecopilot(agentId) !== null) return true;
  return (metadata as { userMemory?: boolean } | null)?.userMemory === true;
}
