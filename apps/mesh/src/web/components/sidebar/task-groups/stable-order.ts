/**
 * Per-user sidebar group ordering (localStorage).
 *
 * Two reorderable sections:
 * - Org-pinned agents (`sidebar.org-pinned-order.<orgId>`) — server `pinned: true`
 * - Personal agents (`sidebar.group-order.<orgId>.<userId>`) — user sidebar membership
 *
 * Hide removes an id from the personal list only. Decopilot stays first when present;
 * Automation runs stays last. Drag-and-drop never crosses the section boundary.
 */
import { LOCALSTORAGE_KEYS } from "@/web/lib/localstorage-keys";
import { TOOL_CALL_RUNS_GROUP_KEY, type TaskGroupData } from "./group-threads";

export interface SidebarOrderScope {
  orgId: string;
  userId: string;
}

export type SidebarGroupSection = "org" | "user";

const userOrderCache = new Map<string, string[]>();
const orgOrderCache = new Map<string, string[]>();

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

function loadUserOrder(
  scope: SidebarOrderScope,
  orgPinnedIds: string[],
): string[] {
  const orgPinnedSet = new Set(orgPinnedIds);
  const cacheKey = userCacheKey(scope);

  let order: string[];
  const cached = userOrderCache.get(cacheKey);
  if (cached) {
    order = cached;
  } else {
    const key = LOCALSTORAGE_KEYS.sidebarGroupOrder(scope.orgId, scope.userId);
    order = readStoredOrder(key);
    if (order.length === 0 && scope.userId !== "anon") {
      const legacy = readStoredOrder(legacyOrderKey(scope.orgId));
      if (legacy.length > 0) {
        order = legacy;
      }
    }
  }

  const filtered = order.filter((id) => !orgPinnedSet.has(id));
  if (!cached || filtered.length !== order.length) {
    saveUserOrder(scope, filtered);
  }
  return filtered;
}

function saveUserOrder(scope: SidebarOrderScope, order: string[]): void {
  userOrderCache.set(userCacheKey(scope), order);
  writeStoredOrder(
    LOCALSTORAGE_KEYS.sidebarGroupOrder(scope.orgId, scope.userId),
    order,
  );
}

function loadOrgPinnedOrder(orgId: string): string[] {
  const cached = orgOrderCache.get(orgId);
  if (cached) return cached;

  const order = readStoredOrder(LOCALSTORAGE_KEYS.sidebarOrgPinnedOrder(orgId));
  orgOrderCache.set(orgId, order);
  return order;
}

function saveOrgPinnedOrder(orgId: string, order: string[]): void {
  orgOrderCache.set(orgId, order);
  writeStoredOrder(LOCALSTORAGE_KEYS.sidebarOrgPinnedOrder(orgId), order);
}

export function saveGroupOrder(
  scope: SidebarOrderScope,
  order: string[],
): void {
  saveUserOrder(scope, order);
}

export function saveOrgGroupOrder(orgId: string, order: string[]): void {
  saveOrgPinnedOrder(orgId, order);
}

function isFixedGroupId(
  id: string,
  decopilotVirtualMcpId: string | null,
): boolean {
  return id === decopilotVirtualMcpId || id === TOOL_CALL_RUNS_GROUP_KEY;
}

export function isOrgPinnedAgent(
  virtualMcpId: string,
  orgPinnedIds: string[],
): boolean {
  return orgPinnedIds.includes(virtualMcpId);
}

/** Middle-section ids (excluding Decopilot and Automation runs). */
export function sortableGroupIds(
  groups: TaskGroupData[],
  decopilotVirtualMcpId: string | null,
): string[] {
  return groups
    .map((g) => g.virtualMcpId)
    .filter((id) => !isFixedGroupId(id, decopilotVirtualMcpId));
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
  const missing = requiredIds.filter((id) => !order.includes(id));
  if (missing.length === 0) return order;
  return [...order, ...missing];
}

function mergeNewUserIdsIntoOrder(
  order: string[],
  currentUserIds: string[],
): string[] {
  const known = new Set(order);
  const newIds = currentUserIds.filter((id) => !known.has(id));
  if (newIds.length === 0) return order;
  return [...newIds, ...order];
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
  const middleIds = sortableGroupIds(groups, decopilotVirtualMcpId);
  const userMiddleIds = middleIds.filter((id) => !orgPinnedSet.has(id));

  const orgRequired = orgPinnedIds.filter(
    (id) => !isFixedGroupId(id, decopilotVirtualMcpId),
  );
  const orgOrder = mergeMissingIds(savedOrgOrder, orgRequired);
  const savedUserWithoutOrgPins = savedUserOrder.filter(
    (id) => !orgPinnedSet.has(id),
  );
  const userOrder = mergeNewUserIdsIntoOrder(
    savedUserWithoutOrgPins,
    userMiddleIds,
  );

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
  const orderedUser = userOrder
    .filter((id) => !orgPinnedSet.has(id))
    .map(toGroup);

  const trailingUser = userMiddleIds
    .filter((id) => !userOrder.includes(id))
    .map((id) => byId.get(id)!);

  const result: TaskGroupData[] = [];
  if (decopilot) result.push(decopilot);
  result.push(...orderedOrg, ...orderedUser, ...trailingUser);
  if (toolCallRuns) result.push(toolCallRuns);

  return {
    groups: result,
    userOrder: [
      ...userOrder,
      ...trailingUser
        .map((g) => g.virtualMcpId)
        .filter((id) => !userOrder.includes(id)),
    ],
    orgOrder: orderedOrg.map((g) => g.virtualMcpId),
  };
}

function migrateLegacyCombinedOrder(
  scope: SidebarOrderScope,
  orgPinnedIds: string[],
): void {
  const orgPinnedSet = new Set(orgPinnedIds);
  if (orgPinnedSet.size === 0) return;

  const orgKey = LOCALSTORAGE_KEYS.sidebarOrgPinnedOrder(scope.orgId);
  const existingOrg = readStoredOrder(orgKey);
  if (existingOrg.length > 0) return;

  const userKey = LOCALSTORAGE_KEYS.sidebarGroupOrder(
    scope.orgId,
    scope.userId,
  );
  let userOrder = readStoredOrder(userKey);
  if (userOrder.length === 0) {
    userOrder = readStoredOrder(legacyOrderKey(scope.orgId));
  }
  if (userOrder.length === 0) return;

  const extractedOrg = userOrder.filter((id) => orgPinnedSet.has(id));
  if (extractedOrg.length === 0) return;

  const nextUser = userOrder.filter((id) => !orgPinnedSet.has(id));
  saveOrgPinnedOrder(scope.orgId, extractedOrg);
  saveUserOrder(scope, nextUser);
}

export function applyGroupOrder(
  scope: SidebarOrderScope,
  groups: TaskGroupData[],
  decopilotVirtualMcpId: string | null,
  orgPinnedIds: string[] = [],
): TaskGroupData[] {
  migrateLegacyCombinedOrder(scope, orgPinnedIds);
  const savedUser = loadUserOrder(scope, orgPinnedIds);
  const savedOrg = loadOrgPinnedOrder(scope.orgId);
  const {
    groups: ordered,
    userOrder,
    orgOrder,
  } = computeGroupOrder(
    groups,
    savedUser,
    decopilotVirtualMcpId,
    orgPinnedIds,
    savedOrg,
  );

  if (
    userOrder.length !== savedUser.length ||
    userOrder.some((id, index) => id !== savedUser[index])
  ) {
    saveUserOrder(scope, userOrder);
  }
  if (
    orgOrder.length !== savedOrg.length ||
    orgOrder.some((id, index) => id !== savedOrg[index])
  ) {
    saveOrgPinnedOrder(scope.orgId, orgOrder);
  }

  return ordered;
}

export function syncOrdersOnOrgPinToggle(
  scope: SidebarOrderScope,
  virtualMcpId: string,
  pinned: boolean,
): void {
  if (pinned) {
    const user = loadUserOrder(scope, [virtualMcpId]).filter(
      (id) => id !== virtualMcpId,
    );
    saveUserOrder(scope, user);

    const org = loadOrgPinnedOrder(scope.orgId);
    if (!org.includes(virtualMcpId)) {
      saveOrgPinnedOrder(scope.orgId, [...org, virtualMcpId]);
    }
    return;
  }

  const org = loadOrgPinnedOrder(scope.orgId).filter(
    (id) => id !== virtualMcpId,
  );
  saveOrgPinnedOrder(scope.orgId, org);

  const user = loadUserOrder(scope, []);
  if (!user.includes(virtualMcpId)) {
    saveUserOrder(scope, [...user, virtualMcpId]);
  }
}

export function removeGroupFromOrder(
  scope: SidebarOrderScope,
  virtualMcpId: string,
  orgPinnedIds: string[] = [],
): void {
  const current = loadUserOrder(scope, orgPinnedIds);
  const next = current.filter((id) => id !== virtualMcpId);
  if (next.length === current.length) return;
  saveUserOrder(scope, next);
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

  const current = loadUserOrder(scope, orgPinnedIds);
  const userSet = new Set(reorderedSectionIds);
  const preservedTail = current.filter((id) => !userSet.has(id));
  return [...reorderedSectionIds, ...preservedTail];
}
