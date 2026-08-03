import {
  parseBranchMap,
  type SandboxMap,
  type SandboxRecord,
} from "@decocms/shared/sdk";
import type { StudioContext } from "../../core/studio-context";
import {
  AGENT_SANDBOX_KIND,
  readSandboxMap,
  removeAgentSandboxMapEntry,
} from "./sandbox-map";
import {
  assertThreadSandboxMutationAuthority,
  getThreadSandboxMap,
  removeThreadSandboxMapEntryStrict,
  threadIdFromBranch,
} from "./thread-repo";

export { AGENT_SANDBOX_KIND } from "./sandbox-map";

function agentRecord(entry: SandboxRecord | null): SandboxRecord | null {
  if (
    entry?.sandboxProviderKind &&
    entry.sandboxProviderKind !== AGENT_SANDBOX_KIND
  ) {
    return null;
  }
  return entry;
}

/** Select only a record that is safe to route through AgentSandboxProvider. */
export function selectAgentSandboxBranchRecord(
  raw: SandboxMap[string][string] | undefined,
): SandboxRecord | null {
  return agentRecord(parseBranchMap(raw)[AGENT_SANDBOX_KIND] ?? null);
}

export function selectAgentSandboxRecord(
  sandboxMap: SandboxMap,
  sandboxUserId: string,
  branch: string,
): SandboxRecord | null {
  return selectAgentSandboxBranchRecord(sandboxMap[sandboxUserId]?.[branch]);
}

/**
 * Resolve the canonical hosted record. Thread-scoped sandboxes are persisted
 * on the thread because the synthetic Decopilot agent has no writable row.
 */
export async function resolveAgentSandboxRecord(args: {
  ctx: StudioContext;
  virtualMcpId: string;
  virtualMcpMetadata: Record<string, unknown> | null | undefined;
  sandboxUserId: string;
  branch: string;
}): Promise<SandboxRecord | null> {
  const { ctx, virtualMcpId, virtualMcpMetadata, sandboxUserId, branch } = args;
  const threadId = threadIdFromBranch(branch);
  if (threadId) {
    const threadMap = await getThreadSandboxMap(ctx, threadId, virtualMcpId);
    if (!threadMap) return null;
    const threadEntry = selectAgentSandboxRecord(
      threadMap,
      sandboxUserId,
      branch,
    );
    if (threadEntry) return threadEntry;
  }

  return selectAgentSandboxRecord(
    readSandboxMap(virtualMcpMetadata),
    sandboxUserId,
    branch,
  );
}

async function settleRemovals(removals: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(removals);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to clear agent sandbox records");
  }
}

/**
 * Clear both possible registrations for one hosted sandbox. Each removal is
 * idempotent; a legacy user-desktop sibling is deliberately left untouched.
 */
export async function removeAgentSandboxRecords(args: {
  ctx: StudioContext;
  virtualMcpId: string;
  actingUserId: string;
  sandboxUserId: string;
  branch: string;
}): Promise<void> {
  const { ctx, virtualMcpId, actingUserId, sandboxUserId, branch } = args;
  const threadId = threadIdFromBranch(branch);
  if (threadId) {
    await assertThreadSandboxMutationAuthority(
      ctx,
      threadId,
      virtualMcpId,
      actingUserId,
      sandboxUserId,
    );
  }

  const removals = [
    removeAgentSandboxMapEntry(
      ctx.storage.virtualMcps,
      virtualMcpId,
      actingUserId,
      sandboxUserId,
      branch,
    ),
  ];

  if (threadId) {
    removals.push(
      removeThreadSandboxMapEntryStrict(
        ctx,
        threadId,
        virtualMcpId,
        actingUserId,
        sandboxUserId,
        branch,
      ),
    );
  }
  await settleRemovals(removals);
}
