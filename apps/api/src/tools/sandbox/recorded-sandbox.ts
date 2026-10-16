import type { SandboxRecord } from "@decocms/shared/sdk";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import { readSandboxMap, resolveVm } from "./sandbox-map";
import {
  getThreadSandboxMap,
  resolveSandboxUserId,
  threadIdFromBranch,
} from "./thread-repo";

/**
 * Where a sandbox for this agent and branch is recorded, without probing or
 * provisioning it. Inline auth + lookup; the standard `requireVmEntry` runs
 * `ctx.access.check()`, which expects resource scoping that the streaming turn
 * doesn't carry.
 */
export async function lookupRecordedSandbox(
  input: { virtualMcpId: string; branch: string },
  ctx: StudioContext,
) {
  requireAuth(ctx);
  const organization = requireOrganization(ctx);
  const userId = getUserId(ctx);
  if (!userId) throw new Error("User ID required");

  const virtualMcp = await ctx.storage.virtualMcps.findById(input.virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    throw new Error("Virtual MCP not found");
  }
  const metadata = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  // See resolveSandboxUserId: one sandbox per thread, keyed by its creator.
  const sandboxUserId = await resolveSandboxUserId(ctx, input.branch, userId);
  // Thread-scoped sandboxes are recorded on the thread (the agent write is a
  // no-op for them), so the resume fast path has to look there too.
  const recordThreadId =
    threadIdFromBranch(input.branch) ?? ctx.metadata?.threadId;
  const agentEntry = resolveVm(
    readSandboxMap(metadata),
    sandboxUserId,
    input.branch,
  );
  const existing: SandboxRecord | null =
    agentEntry ??
    (recordThreadId
      ? resolveVm(
          await getThreadSandboxMap(ctx, recordThreadId),
          sandboxUserId,
          input.branch,
        )
      : null);
  return {
    organization,
    userId,
    metadata,
    sandboxUserId,
    recordThreadId,
    agentEntry,
    existing,
  };
}

/**
 * The sandbox a run on this agent and branch uses, if one is recorded. Never
 * provisions: for a caller that only wants to reach a sandbox that is already
 * running something.
 */
export async function findRecordedSandbox(
  input: { virtualMcpId: string; branch: string },
  ctx: StudioContext,
): Promise<SandboxRecord | null> {
  return (await lookupRecordedSandbox(input, ctx)).existing;
}
