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

/** Narrow context interface the hosted Decopilot stream takes. Cluster-specific
 *  surface (DB, vault, auth, MCP gateway internals) lives on the wider
 *  StudioContext; cluster-only services are supplied by the registered
 *  environment builder, not through
 *  `DecopilotStreamInput`.
 *
 *  Re-declared here (mirroring `apps/api/src/core/harness-context.ts`) so
 *  the package stays portable. The cluster's richer `StudioContext` is
 *  structurally assignable to this shape. */
export interface HarnessContext {
  tracer: import("@opentelemetry/api").Tracer;
  meter: import("@opentelemetry/api").Meter;
  metadata: {
    threadId?: string;
    orgId?: string;
    userId?: string;
  };
  /** Optional provider activation seam used by hosted Decopilot. */
  aiProviders?: {
    activate(
      credentialId: string,
      organizationId: string,
    ): Promise<unknown | null>;
  };
}
