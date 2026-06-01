/**
 * Stable group ordering for the sidebar.
 *
 * Active agents (those with at least one thread) always sort by recency so
 * the agent you just talked to floats to the top. Inactive agents (directory
 * entries with no threads) keep a stable per-org order so they don't shuffle
 * around on every render. Decopilot is always pinned first.
 *
 * The cache is a module-scoped Map that mirrors localStorage so we don't
 * re-parse the stored JSON on every render.
 */
import type { TaskGroupData } from "./group-threads";

const STORAGE_KEY_PREFIX = "sidebar.group-order.";
const orderCache = new Map<string, string[]>();

function loadOrder(orgId: string): string[] {
  const cached = orderCache.get(orgId);
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(`${STORAGE_KEY_PREFIX}${orgId}`);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    const order = Array.isArray(parsed)
      ? (parsed.filter((v) => typeof v === "string") as string[])
      : [];
    orderCache.set(orgId, order);
    return order;
  } catch {
    return [];
  }
}

function saveOrder(orgId: string, order: string[]): void {
  orderCache.set(orgId, order);
  try {
    localStorage.setItem(
      `${STORAGE_KEY_PREFIX}${orgId}`,
      JSON.stringify(order),
    );
  } catch {
    // localStorage unavailable / quota — in-memory cache still wins.
  }
}

export function stabilizeGroupOrder(
  orgId: string,
  groups: TaskGroupData[],
  decopilotVirtualMcpId: string | null,
): TaskGroupData[] {
  const decopilot = decopilotVirtualMcpId
    ? groups.find((g) => g.virtualMcpId === decopilotVirtualMcpId)
    : undefined;
  const rest = groups.filter((g) => g.virtualMcpId !== decopilotVirtualMcpId);

  // Active agents always sort by most-recently-updated so the last one you
  // talked to rises to the top.
  const active = rest
    .filter((g) => g.threads.length > 0)
    .sort((a, b) => b.latestUpdatedAt.localeCompare(a.latestUpdatedAt));

  // Inactive agents keep a stable order to prevent alphabetical churn.
  const inactive = rest.filter((g) => g.threads.length === 0);
  let inactiveOrder = loadOrder(orgId);
  const known = new Set(inactiveOrder);
  const newIds = inactive
    .map((g) => g.virtualMcpId)
    .filter((id) => !known.has(id));
  if (newIds.length > 0) {
    inactiveOrder = [...inactiveOrder, ...newIds];
    saveOrder(orgId, inactiveOrder);
  }
  const inactiveById = new Map(inactive.map((g) => [g.virtualMcpId, g]));
  const inactiveOrdered = inactiveOrder
    .filter((id) => inactiveById.has(id))
    .map((id) => inactiveById.get(id)!);

  const result: TaskGroupData[] = [];
  if (decopilot) result.push(decopilot);
  result.push(...active, ...inactiveOrdered);
  return result;
}
