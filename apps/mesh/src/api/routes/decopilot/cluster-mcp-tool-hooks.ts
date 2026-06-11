/**
 * Cluster adapter — MCP tool-call hooks built from a StudioContext.
 *
 * The portable tool assembly (`harnesses/decopilot/mcp-tools.ts` and its
 * callers `tools.ts` / `assemble-agent-tools.ts`) takes `resolveArgs` and
 * `onToolCalled` as injected, ctx-free hooks. This module builds the cluster
 * implementations of those hooks from a `StudioContext`:
 *
 *   - `resolveArgs`  → resolve `mesh-storage:` refs to presigned URLs.
 *   - `onToolCalled` → emit per-tool-call analytics to PostHog.
 *
 * Lives in the cluster layer (not the portable harness tree) so the
 * harness leaves stay free of `@/posthog` / `file-materializer` reaches.
 * The desktop daemon simply omits these hooks (no ctx → no storage-ref
 * resolution, no analytics — the intended gated behavior).
 */

import type { StudioContext } from "@/core/studio-context";
import { posthog } from "@/posthog";
import type { ToolCallAnalytics } from "@/harnesses/decopilot/mcp-tools";
import { resolveArgsStorageRefs } from "./file-materializer";

export interface ClusterMcpToolHooks {
  resolveArgs: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  onToolCalled: (event: ToolCallAnalytics) => void;
}

/**
 * Build the cluster `resolveArgs` + `onToolCalled` hooks from a
 * StudioContext. The closures are byte-equivalent to the originals that
 * lived in `helpers.ts`'s `toolsFromMCP` wrapper.
 */
export function buildClusterMcpToolHooks(
  ctx: StudioContext,
): ClusterMcpToolHooks {
  return {
    resolveArgs: (input) => resolveArgsStorageRefs(input, ctx),
    onToolCalled: (event) => {
      const orgId = ctx.organization?.id;
      const userId = ctx.auth?.user?.id;
      if (!orgId || !userId) return;
      posthog.capture({
        distinctId: userId,
        event: "tool_called",
        groups: { organization: orgId },
        properties: {
          organization_id: orgId,
          tool_source: "mcp",
          tool_name: event.toolName,
          tool_safe_name: event.toolSafeName,
          read_only: event.annotations?.readOnlyHint ?? null,
          destructive: event.annotations?.destructiveHint ?? null,
          idempotent: event.annotations?.idempotentHint ?? null,
          open_world: event.annotations?.openWorldHint ?? null,
          latency_ms: Math.round(event.latencyMs),
          is_error: event.isError,
        },
      });
    },
  };
}
