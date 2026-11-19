import {
  readToolApprovalLevel,
  usePreferences,
  type ToolApprovalLevel,
} from "@/hooks/use-preferences.ts";
import { useChatPrefs, useChatTask } from "../context";
import type { RequestOptions } from "../store/thread-connection";

/**
 * Request options for answering the open chat (a tool output, an approval)
 * with the person's current tier, mode and agent. Built at call time, so a
 * change made in the same handler is not read stale.
 */
export function useChatRequestOptions({
  voiceMode = false,
}: {
  voiceMode?: boolean;
} = {}) {
  const [preferences] = usePreferences();
  const { virtualMcpId } = useChatTask();
  const { chatMode, simpleModeTier } = useChatPrefs();
  const currentApprovalLevel: ToolApprovalLevel =
    preferences.toolApprovalLevel ?? readToolApprovalLevel();

  /** `toolApprovalLevel` overrides the saved one when the same handler is
   *  changing it. */
  return (
    toolApprovalLevel: ToolApprovalLevel = currentApprovalLevel,
  ): RequestOptions => ({
    ...(voiceMode ? { voiceMode: true } : {}),
    tier: simpleModeTier,
    mode: chatMode,
    toolApprovalLevel,
    agent: virtualMcpId ? { id: virtualMcpId } : undefined,
  });
}
