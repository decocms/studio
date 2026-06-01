import { useState } from "react";
import type { TaskGroupData } from "./group-threads";
import {
  computeDisplayGroups,
  ensureGroupOrdersSynced,
  type SidebarOrderScope,
} from "./stable-order";

function orderSyncFingerprint(
  scope: SidebarOrderScope,
  threadGroups: TaskGroupData[],
  orgPinnedIds: string[],
  revision: number,
): string {
  return [
    scope.orgId,
    scope.userId,
    revision,
    orgPinnedIds.slice().sort().join(","),
    threadGroups
      .map((g) => g.virtualMcpId)
      .sort()
      .join(","),
  ].join("|");
}

/**
 * Keeps sidebar group order in localStorage and returns the ordered groups
 * for rendering. Persistence runs when the fingerprint changes (explicit
 * revision bumps or org-pin / thread-group membership changes), not on every
 * unrelated parent re-render.
 */
export function useSidebarGroupOrder(
  scope: SidebarOrderScope,
  threadGroups: TaskGroupData[],
  decopilotId: string | null,
  orgPinnedIds: string[],
  revision: number,
): TaskGroupData[] {
  const fingerprint = orderSyncFingerprint(
    scope,
    threadGroups,
    orgPinnedIds,
    revision,
  );
  const [syncedFingerprint, setSyncedFingerprint] = useState("");

  if (syncedFingerprint !== fingerprint) {
    ensureGroupOrdersSynced(scope, threadGroups, decopilotId, orgPinnedIds);
    setSyncedFingerprint(fingerprint);
  }

  return computeDisplayGroups(scope, threadGroups, decopilotId, orgPinnedIds);
}
