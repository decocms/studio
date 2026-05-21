/**
 * Build Stream Request
 *
 * Converts a stored Automation row into a DispatchRunInput suitable for passing
 * to dispatchRunAndWait(). The caller is expected to resolve the automation's tier via
 * resolveTier() first; the resolved model is passed in here. The automation's
 * stored `models` JSON is no longer read for credential or model info — after
 * migration 077 it carries only `{ tier }`.
 */

import type { DispatchRunInput } from "@/api/routes/decopilot/dispatch-run";
import type { Automation } from "@/storage/types";

type ThinkingShape = {
  id: string;
  title?: string;
  provider?: string | null;
  capabilities?: {
    vision?: boolean;
    text?: boolean;
    reasoning?: boolean;
    file?: boolean;
  };
  limits?: {
    contextWindow?: number;
    maxOutputTokens?: number;
  };
  [key: string]: unknown;
};

export interface ResolvedAutomationModel {
  credentialId: string;
  thinking: ThinkingShape;
}

export function buildStreamRequest(
  automation: Automation,
  triggerId: string | null,
  taskId: string,
  resolved: ResolvedAutomationModel,
): DispatchRunInput {
  const rawMessages = JSON.parse(automation.messages);
  // Generate fresh ids for each run so concurrent automation runs don't
  // collide on the same message id (ON CONFLICT in saveMessages would
  // silently keep the message in the first thread, making it invisible
  // in subsequent threads).
  const messages = rawMessages.map((m: { id?: string; role: string }) => ({
    ...m,
    id: crypto.randomUUID(),
  }));

  const request: DispatchRunInput = {
    messages,
    models: {
      credentialId: resolved.credentialId,
      thinking: resolved.thinking,
    },
    // Caller guarantees `automation.kind === "agent"` (the workflow only
    // takes the agent branch when this invariant holds), so virtual_mcp_id
    // is non-null. The `!` is the cheapest way to express that here.
    agent: { id: automation.virtual_mcp_id! },
    temperature: automation.temperature ?? 0.5,
    toolApprovalLevel: "auto",
    mode: "default",
    organizationId: automation.organization_id,
    userId: automation.created_by,
    triggerId: triggerId ?? undefined,
    taskId,
  };

  return request;
}
