/**
 * Build Stream Request
 *
 * Converts a stored Automation row into a StreamCoreInput suitable
 * for passing to streamCore(). JSON columns are parsed back into objects.
 */

import type { StreamCoreInput } from "@/api/routes/decopilot/stream-core";
import type { Automation } from "@/storage/types";
import { getDecopilotId } from "@decocms/mesh-sdk";

export function buildStreamRequest(
  automation: Automation,
  triggerId: string | null,
  threadId: string,
): StreamCoreInput {
  const rawMessages = JSON.parse(automation.messages);
  // Generate fresh ids for each run so concurrent automation runs don't
  // collide on the same message id (ON CONFLICT in saveMessages would
  // silently keep the message in the first thread, making it invisible
  // in subsequent threads).
  const messages = rawMessages.map((m: { id?: string; role: string }) => ({
    ...m,
    id: crypto.randomUUID(),
  }));
  const request: StreamCoreInput = {
    messages,
    models: JSON.parse(automation.models),
    agent: (() => {
      const parsed = JSON.parse(automation.agent);
      const id = parsed.id || getDecopilotId(automation.organization_id);
      return { id };
    })(),
    temperature: automation.temperature ?? 0.5,
    toolApprovalLevel: "yolo",
    organizationId: automation.organization_id,
    userId: automation.created_by,
    triggerId: triggerId ?? undefined,
    threadId,
  };

  console.log(`[buildStreamRequest] automation="${automation.name}":`, {
    threadId,
    triggerId,
    agentId: request.agent?.id,
    credentialId: request.models?.credentialId,
    modelId: request.models?.thinking?.id,
    messageCount: request.messages.length,
    userId: request.userId,
    orgId: request.organizationId,
  });

  return request;
}
