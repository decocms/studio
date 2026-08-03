/**
 * AgentSandbox registry helpers.
 *
 * Lookup: sandboxMap[userId][branch][sandboxProviderKind] -> SandboxRecord
 *
 * Stored in the virtualmcp's metadata JSON column. Threads sharing the same
 * (user, branch) pair share one hosted sandbox. Legacy desktop siblings remain
 * in the persisted map until their compatibility window ends, but hosted API
 * callers can only read and write the canonical AgentSandbox cell.
 *
 * NOTE: read-modify-write is NOT atomic across pods — two concurrent SANDBOX_START
 * calls for the same (sandbox, user, branch, kind) can race. Accepted for v1. A
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

/**
 * Pure merge: returns a copy of `current` with the canonical AgentSandbox cell
 * set to `entry`. Creates intermediate buckets as needed and preserves sibling
 * users, branches, and legacy kinds. Normalizes the target branch cell through
 * `parseBranchMap` so a legacy stringified cell can't corrupt the spread.
 */
export function mergeAgentSandboxMapEntry(
  current: SandboxMap,
  targetUserId: string,
  branch: string,
  entry: SandboxRecord,
): SandboxMap {
  const currentBranchMap = parseBranchMap(current[targetUserId]?.[branch]);
  const canonicalEntry: SandboxRecord = {
    ...entry,
    sandboxProviderKind: AGENT_SANDBOX_KIND,
  };
  return {
    ...current,
    [targetUserId]: {
      ...(current[targetUserId] ?? {}),
      [branch]: {
        ...currentBranchMap,
        [AGENT_SANDBOX_KIND]: canonicalEntry,
      } as SandboxMap[string][string],
    },
  };
}

/**
 * Read-modify-write: sets the hosted AgentSandbox record on the virtual MCP.
 * Preserves legacy sibling-kind entries already present in the persisted map.
 */
export async function setAgentSandboxMapEntry(
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
  const next = mergeAgentSandboxMapEntry(
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
 * Pure removal of the canonical AgentSandbox cell. Prunes the branch bucket
 * when no kinds remain and the user bucket when no branches remain. Returns
 * `null` when the entry wasn't present so callers can skip a no-op write.
 */
export function deleteAgentSandboxMapEntry(
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
 * Read-modify-write: removes the hosted AgentSandbox record while preserving
 * any legacy sibling kind.
 */
export async function removeAgentSandboxMapEntry(
  storage: VirtualMCPStoragePort,
  virtualMcpId: string,
  actingUserId: string,
  targetUserId: string,
  branch: string,
): Promise<void> {
  const virtualMcp = await storage.findById(virtualMcpId);
  if (!virtualMcp) return;

  const meta = (virtualMcp.metadata ?? {}) as Record<string, unknown>;
  const next = deleteAgentSandboxMapEntry(
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
