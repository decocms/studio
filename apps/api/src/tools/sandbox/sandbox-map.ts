/**
 * sandboxMap helpers — per-(user, branch, sandboxProviderKind) sandbox registry.
 *
 * Lookup: sandboxMap[userId][branch][sandboxProviderKind] -> SandboxRecord
 *
 * Stored in the virtualmcp's metadata JSON column. Threads sharing the same
 * (user, branch, kind) triple share one sandbox.
 *
 * NOTE: read-modify-write is NOT atomic across pods — two concurrent SANDBOX_START
 * calls for the same (sandbox, user, branch, kind) can race. Accepted for v1. A
 * proper fix requires a Postgres advisory lock or a dedicated sandbox_sessions table.
 */

import { parseBranchMap } from "@decocms/shared/sdk";
import type { SandboxMap, SandboxRecord } from "@decocms/shared/sdk";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

import type { VirtualMCPStoragePort } from "../../storage/ports";
import type { VirtualMCPUpdateData } from "../virtual/schema";

export function readSandboxMap(
  metadata: Record<string, unknown> | null | undefined,
): SandboxMap {
  if (!metadata || typeof metadata !== "object") return {};
  const raw = (metadata as { sandboxMap?: unknown }).sandboxMap;
  if (!raw || typeof raw !== "object") return {};
  return raw as SandboxMap;
}

export function resolveVm(
  sandboxMap: SandboxMap,
  userId: string,
  branch: string,
  sandboxProviderKind: SandboxProviderKind,
): SandboxRecord | null {
  const raw = sandboxMap[userId]?.[branch];
  if (!raw) return null;
  const parsed = parseBranchMap(raw);
  return parsed[sandboxProviderKind] ?? null;
}

/**
 * Pure merge: returns a copy of `current` with sandboxMap[userId][branch][kind]
 * set to `entry`. Creates intermediate buckets as needed and preserves any
 * sibling users, branches, and kinds. Normalizes the target branch cell through
 * `parseBranchMap` so a legacy stringified cell can't corrupt the spread. The
 * single source of truth for both the agent-scoped (`setSandboxMapEntry`) and
 * thread-scoped (`setThreadSandboxMapEntry`) writers.
 */
export function mergeSandboxMapEntry(
  current: SandboxMap,
  targetUserId: string,
  branch: string,
  sandboxProviderKind: SandboxProviderKind,
  entry: SandboxRecord,
): SandboxMap {
  const currentBranchMap = parseBranchMap(current[targetUserId]?.[branch]);
  return {
    ...current,
    [targetUserId]: {
      ...(current[targetUserId] ?? {}),
      [branch]: {
        ...currentBranchMap,
        [sandboxProviderKind]: entry,
      } as SandboxMap[string][string],
    },
  };
}

/**
 * Read-modify-write: sets sandboxMap[userId][branch][kind] = entry on the
 * virtualmcp. Creates intermediate buckets as needed. Preserves any
 * sibling-kind entries already present at sandboxMap[userId][branch][*].
 */
export async function setSandboxMapEntry(
  storage: VirtualMCPStoragePort,
  virtualMcpId: string,
  actingUserId: string,
  targetUserId: string,
  branch: string,
  sandboxProviderKind: SandboxProviderKind,
  entry: SandboxRecord,
): Promise<void> {
  const virtualMcp = await storage.findById(virtualMcpId);
  if (!virtualMcp) return;

  const meta = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const next = mergeSandboxMapEntry(
    readSandboxMap(meta),
    targetUserId,
    branch,
    sandboxProviderKind,
    entry,
  );

  await storage.update(virtualMcpId, actingUserId, {
    metadata: {
      ...meta,
      sandboxMap: next,
    } as VirtualMCPUpdateData["metadata"],
  });
}

/**
 * Pure removal: returns a copy of `current` without sandboxMap[userId][branch]
 * [kind]. Prunes the branch bucket when no kinds remain and the user bucket when
 * no branches remain. Returns `null` when the entry wasn't present (so callers
 * can skip a no-op write). Shared by the agent-scoped (`removeSandboxMapEntry`)
 * and thread-scoped (`removeThreadSandboxMapEntryStrict`) removers.
 */
export function deleteSandboxMapEntry(
  current: SandboxMap,
  targetUserId: string,
  branch: string,
  sandboxProviderKind: SandboxProviderKind,
): SandboxMap | null {
  const branchMap = parseBranchMap(current[targetUserId]?.[branch]);
  if (!branchMap[sandboxProviderKind]) return null;

  const nextBranchMap = { ...branchMap };
  delete nextBranchMap[sandboxProviderKind];

  const userMap = { ...(current[targetUserId] ?? {}) };
  if (Object.keys(nextBranchMap).length === 0) {
    delete userMap[branch];
  } else {
    userMap[branch] = nextBranchMap as SandboxMap[string][string];
  }

  const next: SandboxMap = { ...current };
  if (Object.keys(userMap).length === 0) {
    delete next[targetUserId];
  } else {
    next[targetUserId] = userMap;
  }
  return next;
}

/**
 * Read-modify-write: removes sandboxMap[userId][branch][kind].
 * Drops the branch bucket if no kinds remain; drops the user bucket if no
 * branches remain.
 */
export async function removeSandboxMapEntry(
  storage: VirtualMCPStoragePort,
  virtualMcpId: string,
  actingUserId: string,
  targetUserId: string,
  branch: string,
  sandboxProviderKind: SandboxProviderKind,
): Promise<void> {
  const virtualMcp = await storage.findById(virtualMcpId);
  if (!virtualMcp) return;

  const meta = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const next = deleteSandboxMapEntry(
    readSandboxMap(meta),
    targetUserId,
    branch,
    sandboxProviderKind,
  );
  if (!next) return;

  await storage.update(virtualMcpId, actingUserId, {
    metadata: {
      ...meta,
      sandboxMap: next,
    } as VirtualMCPUpdateData["metadata"],
  });
}
