/**
 * Cluster adapter — MCP tool-call hooks built from a StudioContext.
 *
 * The portable tool assembly (`harnesses/decopilot/mcp-tools.ts` and its
 * callers `tools.ts` / `assemble-agent-tools.ts`) takes `resolveArgs` and
 * `onToolCalled` as injected, ctx-free hooks. This module builds the cluster
 * implementations of those hooks from a `StudioContext`:
 *
 *   - `resolveArgs`  → resolve `studio-storage:` refs to presigned URLs.
 *   - `onToolCalled` → emit per-tool-call analytics to PostHog.
 *
 * Lives in the cluster layer (not the portable harness tree) so the
 * harness leaves stay free of `@/posthog` / `file-materializer` reaches.
 * The desktop daemon simply omits these hooks (no ctx → no storage-ref
 * resolution, no analytics — the intended gated behavior).
 */

import type { StudioContext } from "@/core/studio-context";
import { posthog } from "@/posthog";
import type {
  PrOpenedEvent,
  ToolCallAnalytics,
} from "@decocms/harness/decopilot/mcp-tools";
import { resolveArgsStorageRefs } from "./file-materializer";
import {
  advanceTaskBoardForRun,
  capturePrForRun,
  isPrCreateMcpTool,
} from "@/tools/task-board/run-reactions";

export interface ClusterMcpToolHooks {
  resolveArgs: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  onToolCalled: (event: ToolCallAnalytics) => void;
  onPrOpened: (event: PrOpenedEvent) => void;
}

/**
 * Build the cluster `resolveArgs` + `onToolCalled` hooks from a
 * StudioContext. The closures are byte-equivalent to the originals that
 * lived in `helpers.ts`'s `toolsFromMCP` wrapper.
 *
 * `threadId` is passed through to the PR-open task-board reaction so it can
 * resolve a linked task via `task_board_item_threads` when the run carries no
 * `runMetadata.taskBoardItemId` (a re-prompted, repo-backed task's PR).
 */
export function buildClusterMcpToolHooks(
  ctx: StudioContext,
  threadId?: string,
): ClusterMcpToolHooks {
  return {
    resolveArgs: (input) => resolveArgsStorageRefs(input, ctx),
    onToolCalled: (event) => {
      // A Super Agent task run just opened a PR via the GitHub MCP tool —
      // move its card to In Review. Fire-and-forget (no-ops off a task run).
      if (!event.isError && isPrCreateMcpTool(event.toolName)) {
        void advanceTaskBoardForRun(ctx, "in_review", threadId);
      }
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
    onPrOpened: (event) => {
      // A PR was opened via the GitHub MCP — link it to the run's task, using
      // the source connection so the modal can fetch it back live. Separate
      // from the In Review advance above (which rides onToolCalled).
      void capturePrForRun(ctx, event.result, event.connectionId, threadId);
    },
  };
}
