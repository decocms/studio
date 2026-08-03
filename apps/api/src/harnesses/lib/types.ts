import type {
  ChatMessage,
  ChatMode,
  ModelsConfig,
  ToolApprovalLevel,
} from "@decocms/shared/harness/types";

// Shared domain types are re-exported here so API harness internals keep one
// import path.
export * from "@decocms/shared/harness/types";

/** Request data consumed by the one hosted Decopilot runtime. Process-local
 *  authority such as the selected Virtual MCP lives in `DecopilotRunContext`,
 *  not in this request data. */
export interface DecopilotStreamInput {
  threadId: string;
  userMessage: ChatMessage;
  models: ModelsConfig;
  mode: ChatMode;
  temperature: number;
  toolApprovalLevel: ToolApprovalLevel;
  toolAllowlist?: string[] | null;
  maxAgentSteps?: number;
  user: { id: string; email: string };
  organizationId: string;
  currentThreadTitle?: string;
  signal: AbortSignal;
}

export { createSecretModelSource } from "./sources";
export type {
  DecopilotSecretModelSource,
  DecopilotSecretModelSources,
} from "./sources";
