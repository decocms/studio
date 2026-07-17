/**
 * Decopilot Helper Functions
 *
 * Utility functions for request validation, context management, and tool conversion.
 */

import type { Context } from "hono";

import type { StudioContext, OrganizationScope } from "@/core/studio-context";
import { HTTPException } from "hono/http-exception";
import {
  buildSanitizedNameMap,
  sanitizeToolName,
  toolNeedsApproval,
  type ToolApprovalLevel,
} from "@decocms/harness/decopilot/mcp-tools";

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
  c: Context<{ Variables: { studioContext: StudioContext } }>,
): OrganizationScope {
  const organization = c.get("studioContext").organization;
  if (!organization) {
    throw new Error("Organization context is required");
  }
  if ((organization.slug ?? organization.id) !== c.req.param("org")) {
    throw new Error("Organization mismatch");
  }
  return organization;
}

/**
 * Validate that a thread exists and belongs to the org.
 * Does NOT enforce ownership — any authenticated org member can access.
 * Use this for read-only / observability endpoints (e.g. stream).
 */
export async function validateThreadAccess(
  c: Context<{ Variables: { studioContext: StudioContext } }>,
) {
  const ctx = c.get("studioContext");
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
  c: Context<{ Variables: { studioContext: StudioContext } }>,
) {
  const result = await validateThreadAccess(c);
  if (result.thread.created_by !== result.userId) {
    throw new HTTPException(403, { message: "Not authorized" });
  }
  return result;
}
