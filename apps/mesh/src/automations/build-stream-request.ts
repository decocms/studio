/**
 * Build Stream Request
 *
 * Converts a stored Automation row into a StreamCoreInput suitable
 * for passing to streamCore(). JSON columns are parsed back into objects.
 */

import type { StreamCoreInput } from "@/api/routes/decopilot/stream-core";
import type { Automation } from "@/storage/types";

export function buildStreamRequest(
  automation: Automation,
  triggerId: string | null,
  threadId: string,
): StreamCoreInput {
  return {
    messages: JSON.parse(automation.messages),
    models: JSON.parse(automation.models),
    agent: JSON.parse(automation.agent),
    temperature: automation.temperature ?? 0.5,
    toolApprovalLevel: (automation.tool_approval_level ?? "none") as
      | "none"
      | "readonly"
      | "yolo",
    organizationId: automation.organization_id,
    userId: automation.created_by,
    triggerId: triggerId ?? undefined,
    threadId,
  };
}
