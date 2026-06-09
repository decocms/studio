/**
 * Decopilot Helper Functions
 *
 * Utility functions for request validation, context management, and tool conversion.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolSet, UIMessageStreamWriter } from "ai";
import type { Context } from "hono";

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import { posthog } from "@/posthog";
import { HTTPException } from "hono/http-exception";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "@/core/constants";
import { resolveArgsStorageRefs } from "./file-materializer";
import {
  buildSanitizedNameMap,
  sanitizeToolName,
  toolNeedsApproval,
  toolsFromMCP as toolsFromMCPPortable,
  type ToolApprovalLevel,
} from "@/harnesses/decopilot/mcp-tools";

export {
  buildSanitizedNameMap,
  sanitizeToolName,
  toolNeedsApproval,
  type ToolApprovalLevel,
};

/**
 * Ensure organization context exists and matches route param
 */
export function ensureOrganization(
  c: Context<{ Variables: { meshContext: StudioContext } }>,
): OrganizationScope {
  const organization = c.get("meshContext").organization;
  if (!organization) {
    throw new Error("Organization context is required");
  }
  if ((organization.slug ?? organization.id) !== c.req.param("org")) {
    throw new Error("Organization mismatch");
  }
  return organization;
}

export async function toolsFromMCP(
  client: Client,
  toolOutputMap: Map<string, string>,
  writer?: UIMessageStreamWriter,
  toolApprovalLevel: ToolApprovalLevel = "auto",
  options?: {
    disableOutputTruncation?: boolean;
    ctx?: StudioContext;
    isPlanMode?: boolean;
  },
): Promise<{ tools: ToolSet; nameMap: Map<string, string> }> {
  const meshCtx = options?.ctx;
  return toolsFromMCPPortable(
    client,
    toolOutputMap,
    writer,
    toolApprovalLevel,
    {
      disableOutputTruncation: options?.disableOutputTruncation,
      isPlanMode: options?.isPlanMode,
      timeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
      resolveArgs: meshCtx
        ? (input) => resolveArgsStorageRefs(input, meshCtx)
        : undefined,
      onToolCalled: (event) => {
        const orgId = meshCtx?.organization?.id;
        const userId = meshCtx?.auth?.user?.id;
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
    },
  );
}

/**
 * Validate that a thread exists and belongs to the org.
 * Does NOT enforce ownership — any authenticated org member can access.
 * Use this for read-only / observability endpoints (e.g. stream).
 */
export async function validateThreadAccess(
  c: Context<{ Variables: { meshContext: StudioContext } }>,
) {
  const ctx = c.get("meshContext");
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const organization = ensureOrganization(c);
  const taskId = c.req.param("threadId");
  if (!taskId) {
    throw new HTTPException(400, { message: "Missing thread ID" });
  }
  if (/[.*>\s]/.test(taskId)) {
    throw new HTTPException(400, { message: "Invalid thread ID" });
  }
  const thread = await ctx.storage.threads.get(taskId);
  if (!thread) {
    throw new HTTPException(404, { message: "Thread not found" });
  }
  return { ctx, organization, thread, taskId, userId };
}

/**
 * Validate that the caller owns the thread and it belongs to the org.
 * Use this for mutating endpoints (e.g. cancel) where only the owner
 * should be allowed to act.
 */
export async function validateThreadOwnership(
  c: Context<{ Variables: { meshContext: StudioContext } }>,
) {
  const result = await validateThreadAccess(c);
  if (result.thread.created_by !== result.userId) {
    throw new HTTPException(403, { message: "Not authorized" });
  }
  return result;
}
