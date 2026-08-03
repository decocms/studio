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

type ModelShape = {
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
  thinking: ModelShape;
  image?: ModelShape & { credentialId: string };
  webSearch?: ModelShape & { credentialId: string };
  deepResearch?: ModelShape & { credentialId: string };
}

/**
 * Parse the stored `automations.tools` JSON column into a tool-name allowlist.
 * Returns null (= all tools) for null/empty/malformed values so a bad write can
 * never silently strip every tool from an automation.
 */
function parseToolAllowlist(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) {
      return parsed.length > 0 ? parsed : null;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Deterministic id for the synthetic context-event message
 * (`buildDispatchRequestStep`'s fallback when the automation's stored
 * messages contain no non-system message to prepend event parts onto).
 * Must stay stable across a step re-invocation for the same reason the
 * message ids below are taskId-derived rather than random — see comment
 * on `messages` below.
 */
export function contextMessageId(taskId: string): string {
  return `${taskId}:context`;
}

export function buildStreamRequest(
  automation: Automation,
  triggerId: string | null,
  taskId: string,
  resolved: ResolvedAutomationModel,
  runMetadata?: Record<string, string>,
): DispatchRunInput {
  const rawMessages = JSON.parse(automation.messages);
  // Derive ids from taskId rather than crypto.randomUUID(): fresh ids per run
  // still avoid concurrent-run collisions (a shared id would attribute the
  // message to the first thread only), but they must also be STABLE if this
  // function re-runs — buildDispatchRequestStep is a DBOS step that pre-persists
  // this message via PartEmitter before its own output is durably recorded, so
  // a crash mid-step forces a full re-invocation. A random id there would emit
  // a second, orphaned message row instead of the intended idempotent replace.
  const messages = rawMessages.map(
    (m: { id?: string; role: string }, i: number) => ({
      ...m,
      id: `${taskId}:${i}`,
    }),
  );

  const request: DispatchRunInput = {
    messages,
    models: {
      credentialId: resolved.credentialId,
      thinking: resolved.thinking,
      ...(resolved.image ? { image: resolved.image } : {}),
      ...(resolved.webSearch ? { webSearch: resolved.webSearch } : {}),
      ...(resolved.deepResearch ? { deepResearch: resolved.deepResearch } : {}),
    },
    // Caller guarantees `automation.kind === "agent"` (the workflow only
    // takes the agent branch when this invariant holds), so virtual_mcp_id
    // is non-null. The `!` is the cheapest way to express that here.
    agent: { id: automation.virtual_mcp_id! },
    // Per-automation tool allowlist (model-facing tool names). null/absent
    // leaves the run with the bound agent's full toolset.
    toolAllowlist: parseToolAllowlist(automation.tools),
    // Per-automation parent step cap. undefined leaves runAgentLoop on its
    // PARENT_STEP_LIMIT default.
    maxAgentSteps: automation.max_agent_steps ?? undefined,
    temperature: automation.temperature ?? 0.5,
    toolApprovalLevel: "auto",
    mode: "default",
    organizationId: automation.organization_id,
    userId: automation.created_by,
    harnessId: "decopilot",
    sandboxProviderKind: "agent-sandbox",
    triggerId: triggerId ?? undefined,
    ...(runMetadata ? { runMetadata } : {}),
    taskId,
  };

  return request;
}
