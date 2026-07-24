/**
 * Per-user sidebar agent ordering (localStorage): `sidebar.group-order.<orgId>.<userId>`,
 * migrating from the legacy org-wide `sidebar.group-order.<orgId>` key the
 * first time a user has no scoped order of their own.
 */
import { LOCALSTORAGE_KEYS } from "@/lib/localstorage-keys";

export interface SidebarOrderScope {
  orgId: string;
  userId: string;
}

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
