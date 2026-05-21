/**
 * vmMap helpers — per-(user, branch, sandboxProviderKind) vm registry.
 *
 * Lookup: vmMap[userId][branch][sandboxProviderKind] -> VmMapEntry
 *
 * Stored in the virtualmcp's metadata JSON column. Threads sharing the same
 * (user, branch, kind) triple share one vm.
 *
 * NOTE: read-modify-write is NOT atomic across pods — two concurrent VM_START
 * calls for the same (vm, user, branch, kind) can race. Accepted for v1. A
 * proper fix requires a Postgres advisory lock or a dedicated vm_sessions table.
 */

import { parseBranchMap } from "@decocms/mesh-sdk";
import type { VmMap, VmMapEntry } from "@decocms/mesh-sdk";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

import type { VirtualMCPStoragePort } from "../../storage/ports";
import type { VirtualMCPUpdateData } from "../virtual/schema";

export function readVmMap(
  metadata: Record<string, unknown> | null | undefined,
): VmMap {
  if (!metadata || typeof metadata !== "object") return {};
  const map = (metadata as { vmMap?: unknown }).vmMap;
  if (!map || typeof map !== "object") return {};
  return map as VmMap;
}

export function resolveVm(
  vmMap: VmMap,
  userId: string,
  branch: string,
  sandboxProviderKind: SandboxProviderKind,
): VmMapEntry | null {
  const raw = vmMap[userId]?.[branch];
  if (!raw) return null;
  const parsed = parseBranchMap(raw);
  return parsed[sandboxProviderKind] ?? null;
}

/**
 * Read-modify-write: sets vmMap[userId][branch][kind] = entry on the virtualmcp.
 * Creates intermediate buckets as needed. Preserves any sibling-kind entries
 * already present at vmMap[userId][branch][*].
 */
export async function setVmMapEntry(
  storage: VirtualMCPStoragePort,
  virtualMcpId: string,
  actingUserId: string,
  targetUserId: string,
  branch: string,
  sandboxProviderKind: SandboxProviderKind,
  entry: VmMapEntry,
): Promise<void> {
  const virtualMcp = await storage.findById(virtualMcpId);
  if (!virtualMcp) return;

  const meta = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const current = readVmMap(meta);
  const currentBranchMap = parseBranchMap(current[targetUserId]?.[branch]);
  const next: VmMap = {
    ...current,
    [targetUserId]: {
      ...(current[targetUserId] ?? {}),
      [branch]: {
        ...currentBranchMap,
        [sandboxProviderKind]: entry,
      } as VmMap[string][string],
    },
  };

  await storage.update(virtualMcpId, actingUserId, {
    metadata: {
      ...meta,
      vmMap: next,
    } as VirtualMCPUpdateData["metadata"],
  });
}

/**
 * Read-modify-write: removes vmMap[userId][branch][kind].
 * Drops the branch bucket if no kinds remain; drops the user bucket if no
 * branches remain.
 */
export async function removeVmMapEntry(
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
  const current = readVmMap(meta);
  const branchMap = parseBranchMap(current[targetUserId]?.[branch]);
  if (!branchMap[sandboxProviderKind]) return;

  const nextBranchMap = { ...branchMap };
  delete nextBranchMap[sandboxProviderKind];

  const userMap = { ...(current[targetUserId] ?? {}) };
  if (Object.keys(nextBranchMap).length === 0) {
    delete userMap[branch];
  } else {
    userMap[branch] = nextBranchMap as VmMap[string][string];
  }

  const next: VmMap = { ...current };
  if (Object.keys(userMap).length === 0) {
    delete next[targetUserId];
  } else {
    next[targetUserId] = userMap;
  }

  await storage.update(virtualMcpId, actingUserId, {
    metadata: {
      ...meta,
      vmMap: next,
    } as VirtualMCPUpdateData["metadata"],
  });
}
