/**
 * Per-user sidebar group ordering (localStorage).
 *
 * Sidebar membership is explicit only:
 * - Org-pinned agents (`connections.pinned` + `sidebar.org-pinned-order.<orgId>`)
 * - Personal agents (`sidebar.group-order.<orgId>.<userId>`)
 *
 * Agents with tasks but not in either list do not appear. Decopilot is
 * always pinned (even with no threads); tool-call runs render when they
 * have threads. Both are fixed (non-reorderable) groups.
 */
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { TOOL_CALL_RUNS_GROUP_KEY, type TaskGroupData } from "./group-threads";

export interface SidebarOrderScope {
  orgId: string;
  userId: string;
}

export type SidebarGroupSection = "org" | "user";

const userOrderCache = new Map<string, string[]>();

function userCacheKey(scope: SidebarOrderScope): string {
  return `${scope.orgId}:${scope.userId}`;
}

function legacyOrderKey(orgId: string): string {
  return `sidebar.group-order.${orgId}`;
}

function readStoredOrder(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string")
      : [];
  } catch {
    return [];
  }
}

function writeStoredOrder(key: string, order: string[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(order));
  } catch {
    // localStorage unavailable / quota — in-memory cache still wins.
  }
}

function readUserOrderRaw(scope: SidebarOrderScope): string[] {
  const cacheKey = userCacheKey(scope);
  const cached = userOrderCache.get(cacheKey);
  if (cached) return cached;

  const key = LOCALSTORAGE_KEYS.sidebarGroupOrder(scope.orgId, scope.userId);
  let hasScopedOrder = false;
  try {
    hasScopedOrder = localStorage.getItem(key) !== null;
  } catch {
    // localStorage unavailable — fall through without legacy migration.
  }
  let order = readStoredOrder(key);
  if (!hasScopedOrder && order.length === 0 && scope.userId !== "anon") {
    const legacy = readStoredOrder(legacyOrderKey(scope.orgId));
    if (legacy.length > 0) {
      order = legacy;
    }
  }
  userOrderCache.set(cacheKey, order);
  return order;
}

function readUserOrder(
  scope: SidebarOrderScope,
  orgPinnedIds: string[],
): string[] {
  const orgPinnedSet = new Set(orgPinnedIds);
  return readUserOrderRaw(scope).filter((id) => !orgPinnedSet.has(id));
}

function saveUserOrder(scope: SidebarOrderScope, order: string[]): void {
  userOrderCache.set(userCacheKey(scope), order);
  writeStoredOrder(
    LOCALSTORAGE_KEYS.sidebarGroupOrder(scope.orgId, scope.userId),
    order,
  );
}

/** Decopilot and Automation runs are fixed — never reorderable. */
function isFixedSidebarGroupId(
  id: string,
  decopilotVirtualMcpId: string | null,
): boolean {
  return id === decopilotVirtualMcpId || id === TOOL_CALL_RUNS_GROUP_KEY;
}

function isOrgPinnedAgent(
  virtualMcpId: string,
  orgPinnedIds: string[],
): boolean {
  return orgPinnedIds.includes(virtualMcpId);
}

export function sortableGroupIds(
  groups: TaskGroupData[],
  decopilotVirtualMcpId: string | null,
): string[] {
  return groups
    .map((g) => g.virtualMcpId)
    .filter((id) => !isFixedSidebarGroupId(id, decopilotVirtualMcpId));
}

export function sortableGroupIdsForSection(
  groups: TaskGroupData[],
  section: SidebarGroupSection,
  decopilotVirtualMcpId: string | null,
  orgPinnedIds: string[],
): string[] {
  const orgPinnedSet = new Set(orgPinnedIds);
  return sortableGroupIds(groups, decopilotVirtualMcpId).filter((id) =>
    section === "org" ? orgPinnedSet.has(id) : !orgPinnedSet.has(id),
  );
}

function mergeMissingIds(order: string[], requiredIds: string[]): string[] {
  const known = new Set(order);
  const missing = requiredIds.filter((id) => !known.has(id));
  if (missing.length === 0) return order;
  return [...order, ...missing];
}

export interface PartitionedDisplayGroups {
  decopilot?: TaskGroupData;
  orgPinned: TaskGroupData[];
  user: TaskGroupData[];
  toolCallRuns?: TaskGroupData;
}

export function partitionDisplayGroups(
  groups: TaskGroupData[],
  decopilotVirtualMcpId: string | null,
  orgPinnedIds: string[],
): PartitionedDisplayGroups {
  const orgPinnedSet = new Set(orgPinnedIds);
  const orgPinned: TaskGroupData[] = [];
  const user: TaskGroupData[] = [];
  let decopilot: TaskGroupData | undefined;
  let toolCallRuns: TaskGroupData | undefined;

  for (const group of groups) {
    const id = group.virtualMcpId;
    if (decopilotVirtualMcpId && id === decopilotVirtualMcpId) {
      decopilot = group;
      continue;
    }
    if (id === TOOL_CALL_RUNS_GROUP_KEY) {
      toolCallRuns = group;
      continue;
    }
    if (orgPinnedSet.has(id)) {
      orgPinned.push(group);
      continue;
    }
    user.push(group);
  }

  return { decopilot, orgPinned, user, toolCallRuns };
}

export function computeGroupOrder(
  groups: TaskGroupData[],
  savedUserOrder: string[],
  decopilotVirtualMcpId: string | null,
  orgPinnedIds: string[] = [],
  savedOrgOrder: string[] = [],
): {
  groups: TaskGroupData[];
  userOrder: string[];
  orgOrder: string[];
} {
  const decopilot = decopilotVirtualMcpId
    ? groups.find((g) => g.virtualMcpId === decopilotVirtualMcpId)
    : undefined;
  const toolCallRuns = groups.find(
    (g) => g.virtualMcpId === TOOL_CALL_RUNS_GROUP_KEY,
  );
  const orgPinnedSet = new Set(orgPinnedIds);

  const orgRequired = orgPinnedIds.filter(
    (id) => !isFixedSidebarGroupId(id, decopilotVirtualMcpId),
  );
  const orgOrder = mergeMissingIds(savedOrgOrder, orgRequired);
  const userOrder = savedUserOrder.filter((id) => !orgPinnedSet.has(id));

  const byId = new Map(groups.map((g) => [g.virtualMcpId, g] as const));

  const toGroup = (id: string): TaskGroupData => {
    const existing = byId.get(id);
    if (existing) return existing;
    return {
      virtualMcpId: id,
      threads: [],
      latestUpdatedAt: "",
    };
  };

  const orderedOrg = orgOrder.filter((id) => orgPinnedSet.has(id)).map(toGroup);
  const orderedUser = userOrder.map(toGroup);

  const result: TaskGroupData[] = [];
  if (decopilot) result.push(decopilot);
  result.push(...orderedOrg, ...orderedUser);
  if (toolCallRuns) result.push(toolCallRuns);

  return {
    groups: result,
    userOrder,
    orgOrder: orderedOrg.map((g) => g.virtualMcpId),
  };
}

export function appendAgentToPersonalOrder(
  scope: SidebarOrderScope,
  virtualMcpId: string,
  orgPinnedIds: string[] = [],
): void {
  if (orgPinnedIds.includes(virtualMcpId)) return;
  const current = readUserOrder(scope, orgPinnedIds);
  if (current.includes(virtualMcpId)) return;
  saveUserOrder(scope, [virtualMcpId, ...current]);
}

export function reorderGroupIds(
  order: string[],
  activeId: string,
  overId: string,
): string[] {
  const oldIndex = order.indexOf(activeId);
  const newIndex = order.indexOf(overId);
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
    return order;
  }
  const next = [...order];
  const [moved] = next.splice(oldIndex, 1);
  if (moved === undefined) return order;
  next.splice(newIndex, 0, moved);
  return next;
}

export function buildStoredOrderAfterReorder(
  section: SidebarGroupSection,
  scope: SidebarOrderScope,
  orgPinnedIds: string[],
  reorderedSectionIds: string[],
): string[] {
  if (section === "org") {
    return reorderedSectionIds;
  }

  const current = readUserOrder(scope, orgPinnedIds);
  const userSet = new Set(reorderedSectionIds);
  const preservedTail = current.filter((id) => !userSet.has(id));
  return [...reorderedSectionIds, ...preservedTail];
}

export function canReorderAcrossSections(
  activeId: string,
  overId: string,
  orgPinnedIds: string[],
): boolean {
  const activeIsOrg = isOrgPinnedAgent(activeId, orgPinnedIds);
  const overIsOrg = isOrgPinnedAgent(overId, orgPinnedIds);
  return activeIsOrg === overIsOrg;
}
