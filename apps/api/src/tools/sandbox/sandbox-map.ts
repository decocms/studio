/**
 * Hosted sandbox-map helpers.
 *
 * Lookup: sandboxMap[userId][branch][sandboxProviderKind] -> SandboxRecord
 *
 * Stored in the virtualmcp's metadata JSON column. Hosted threads sharing the
 * same (user, branch) pair share one `agent-sandbox` entry. Native `local-api`
 * entries may coexist in the same branch cell and are preserved by writes.
 *
 * NOTE: read-modify-write is NOT atomic across pods — two concurrent SANDBOX_START
 * calls for the same (sandbox, user, branch) can race. Accepted for v1. A
 * proper fix requires a Postgres advisory lock or a dedicated sandbox_sessions table.
 */

import { parseBranchMap } from "@decocms/shared/sdk";
import type { SandboxMap, SandboxRecord } from "@decocms/shared/sdk";

import type { VirtualMCPStoragePort } from "../../storage/ports";
import type { VirtualMCPUpdateData } from "../virtual/schema";

export const AGENT_SANDBOX_KIND = "agent-sandbox" as const;

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
): SandboxRecord | null {
  const raw = sandboxMap[userId]?.[branch];
  if (!raw) return null;
  const parsed = parseBranchMap(raw);
  return parsed[AGENT_SANDBOX_KIND] ?? null;
}

/**
 * Pure merge: returns a copy of `current` with the hosted entry set. Creates
 * intermediate buckets as needed and preserves sibling users, branches, and
 * native entries. Normalizes the target branch cell through `parseBranchMap`
 * so a malformed stringified cell can't corrupt the spread. The
 * single source of truth for both the agent-scoped (`setSandboxMapEntry`) and
 * thread-scoped (`setThreadSandboxMapEntry`) writers.
 */
export function mergeSandboxMapEntry(
  current: SandboxMap,
  targetUserId: string,
  branch: string,
  entry: SandboxRecord,
): SandboxMap {
  const currentBranchMap = parseBranchMap(current[targetUserId]?.[branch]);
  const nextBranchMap = {
    ...currentBranchMap,
    [AGENT_SANDBOX_KIND]: entry,
  };
  return {
    ...current,
    [targetUserId]: {
      ...(current[targetUserId] ?? {}),
      [branch]: nextBranchMap,
    },
  };
}

/**
 * Read-modify-write: sets the hosted entry on the virtualmcp. Creates
 * intermediate buckets as needed and preserves a native sibling entry.
 */
export async function setSandboxMapEntry(
  storage: VirtualMCPStoragePort,
  virtualMcpId: string,
  actingUserId: string,
  targetUserId: string,
  branch: string,
  entry: SandboxRecord,
): Promise<void> {
  const virtualMcp = await storage.findById(virtualMcpId);
  if (!virtualMcp) return;

  const meta = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const next = mergeSandboxMapEntry(
    readSandboxMap(meta),
    targetUserId,
    branch,
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
 * and thread-scoped (`removeThreadSandboxMapEntry`) removers.
 */
export function deleteSandboxMapEntry(
  current: SandboxMap,
  targetUserId: string,
  branch: string,
): SandboxMap | null {
  const branchMap = parseBranchMap(current[targetUserId]?.[branch]);
  if (!branchMap[AGENT_SANDBOX_KIND]) return null;

  const nextBranchMap = { ...branchMap };
  delete nextBranchMap[AGENT_SANDBOX_KIND];

  const userMap = { ...(current[targetUserId] ?? {}) };
  if (Object.keys(nextBranchMap).length === 0) {
    delete userMap[branch];
  } else {
    userMap[branch] = nextBranchMap;
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
): Promise<void> {
  const virtualMcp = await storage.findById(virtualMcpId);
  if (!virtualMcp) return;

  const meta = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const next = deleteSandboxMapEntry(
    readSandboxMap(meta),
    targetUserId,
    branch,
  );
  if (!next) return;

  await storage.update(virtualMcpId, actingUserId, {
    metadata: {
      ...meta,
      sandboxMap: next,
    } as VirtualMCPUpdateData["metadata"],
  });
}
