/**
 * Build Stream Request
 *
 * Converts a stored Automation row into a StreamCoreInput suitable
 * for passing to streamCore(). JSON columns are parsed back into objects.
 *
 * When the persisted models payload carries a Simple Mode `tier`, callers
 * resolve the live slot via `resolveTierOverride()` and pass the resulting
 * `tierOverride` here. The override fully replaces both `credentialId` and
 * `thinking` — partial patching would leave stale capabilities / limits /
 * provider / title from the snapshot, which downstream code (model-compat,
 * stream-core max-tokens cap, telemetry) consumes.
 */

import type { StreamCoreInput } from "@/api/routes/decopilot/stream-core";
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

type AutomationModels = {
  credentialId: string;
  thinking: ThinkingShape;
  tier?: "fast" | "smart" | "thinking";
  [key: string]: unknown;
};

export type TierOverride = {
  credentialId: string;
  thinking: ThinkingShape;
};

export function buildStreamRequest(
  automation: Automation,
  triggerId: string | null,
  taskId: string,
  tierOverride?: TierOverride | null,
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

  const models = JSON.parse(automation.models) as AutomationModels;
  const resolvedModels: AutomationModels = tierOverride
    ? {
        ...models,
        credentialId: tierOverride.credentialId,
        thinking: tierOverride.thinking,
      }
    : models;

  const request: StreamCoreInput = {
    messages,
    models: resolvedModels,
    agent: { id: automation.virtual_mcp_id },
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
