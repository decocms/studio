import type { ThreadMetadata } from "@decocms/shared/entities";
import { useOptionalChatTask } from "@/components/chat/chat-context";

/**
 * Metadata of the session's active thread, or `undefined` outside a thread
 * scope (home draft, project settings). The main consumer is the Fast Preview
 * gate: `resolveFastPreview(vmcpMeta, useActiveThreadMeta())` lets a thread
 * stamped `runtime: "sandbox"` (a coding session) opt out of the
 * project's sandbox-less default. Optional context on purpose — thread-less
 * surfaces resolve the project default.
 */
export function useActiveThreadMeta(): ThreadMetadata | undefined {
  return useOptionalChatTask()?.activeTask?.metadata;
}
