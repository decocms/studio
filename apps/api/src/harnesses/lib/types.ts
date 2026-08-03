// Domain/wire types moved to @decocms/shared/harness/types so apps/web and
// packages/sandbox consume them without depending on this package. Re-exported
// here so the API and harness internals keep their import paths (they follow
// when decopilot/ folds into apps/api).
export * from "@decocms/shared/harness/types";

export { createSecretModelSource } from "./sources";
export type {
  DecopilotMcpSource,
  DecopilotModelSource,
  DecopilotModelSources,
  DecopilotObjectStorageSource,
  DecopilotSandboxSource,
  DecopilotHttpMcpSource,
  DecopilotSecretModelSource,
  DecopilotSecretModelSources,
  McpClientLike,
  OpenMcpSourceOptions,
  OpenedMcpSource,
} from "./sources";

/** Narrow context interface the hosted Decopilot stream takes. Cluster-specific
 *  surface (DB, vault, auth, MCP gateway internals) lives on the wider
 *  StudioContext; cluster-only services are supplied by the registered
 *  environment builder, not through
 *  `HarnessStreamInput`.
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
