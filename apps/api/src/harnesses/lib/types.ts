import type { UIMessageChunk } from "ai";
import type {
  HarnessId,
  HarnessStreamInput,
} from "@decocms/shared/harness/types";

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

/** A Harness produces a stream of UI message chunks for a conversation turn.
 *
 *  The hosted implementation is Decopilot, which runs Vercel AI SDK
 *  `streamText` with built-in tools and MCP. Interactive coding-agent CLIs
 *  live exclusively in Studio Native's Rust PTY runtime and do not implement
 *  this interface.
 *
 *  Output chunks are raw AI SDK `UIMessageChunk` — the shared stream layer
 *  extracts `providerMetadata` from the `finish-message` chunk to persist
 *  resume state. No side channels. */
export interface Harness {
  id: HarnessId;
  stream(input: HarnessStreamInput): AsyncIterable<UIMessageChunk>;
}

/** Narrow context interface every Harness factory takes. Cluster-specific
 *  surface (DB, vault, auth, MCP gateway internals) lives on the wider
 *  StudioContext; harnesses that need cluster-only services receive them
 *  through factory construction (captured in the closure), not through
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

/** A factory binds in-process dependencies (HarnessContext) into a Harness
 *  instance. The registry stores factories rather than singletons because
 *  the harnesses need per-request access to storage, providers, and tracing
 *  via `ctx`. Keeping ctx out of `HarnessStreamInput` means the input shape
 *  stays serializable for a future remote transport. */
export interface HarnessFactory {
  id: HarnessId;
  create(ctx: HarnessContext): Harness;
}
