/**
 * Pure extraction helper for pending approvals from assistant message parts.
 *
 * Extracted as a pure .ts module so it can be imported by bun:test code
 * without dragging in @deco/ui transitively via approval.tsx.
 */

import { stripMcpServerPrefix } from "@/web/lib/tool-namespace";
import { toTitleCase } from "../message/parts/tool-call-part/utils.tsx";

// ============================================================================
// Types
// ============================================================================

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  friendlyName: string;
  input: unknown;
}

// ============================================================================
// Utility: extract pending approvals from message parts
// ============================================================================

export function extractPendingApprovals(
  parts: Array<{
    type: string;
    state?: string;
    approval?: { id: string };
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
  }>,
): PendingApproval[] {
  const result: PendingApproval[] = [];
  for (const part of parts) {
    if (
      "state" in part &&
      part.state === "approval-requested" &&
      "approval" in part &&
      part.approval?.id &&
      "toolCallId" in part &&
      part.toolCallId
    ) {
      const toolName =
        "toolName" in part && typeof part.toolName === "string"
          ? part.toolName
          : part.type.startsWith("tool-")
            ? part.type.replace("tool-", "")
            : "Tool";
      result.push({
        approvalId: part.approval.id,
        toolCallId: part.toolCallId,
        toolName,
        friendlyName: toTitleCase(stripMcpServerPrefix(toolName)),
        input: part.input,
      });
    }
  }
  return result;
}
