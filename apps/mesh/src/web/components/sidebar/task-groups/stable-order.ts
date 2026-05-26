/**
 * Stable group ordering for the sidebar.
 *
 * Once a VM appears in the sidebar it keeps its slot forever (per-org,
 * persisted in localStorage). The first time we see a new VM it slots in
 * immediately after Decopilot, so the user notices it at the top without
 * bumping existing groups around. Archiving every task in a group does NOT
 * remove the group — it stays in the order list and renders with an empty
 * thread array.
 *
 * The cache is a module-scoped Map that mirrors localStorage so we don't
 * re-parse the stored JSON on every render. Both the cache and the
 * localStorage entry are keyed by org id.
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
  let order = loadOrder(orgId);
  const known = new Set(order);
  const currentIds = groups.map((g) => g.virtualMcpId);
  const newIds = currentIds.filter((id) => !known.has(id));

  if (newIds.length > 0) {
    const decopilotIsFirst =
      decopilotVirtualMcpId !== null && order[0] === decopilotVirtualMcpId;
    // If Decopilot is the first known id, keep it pinned; new VMs slot in
    // right after. Otherwise prepend at index 0 (initial seed for a new org).
    const insertAt = decopilotIsFirst ? 1 : 0;
    order = [...order.slice(0, insertAt), ...newIds, ...order.slice(insertAt)];
    saveOrder(orgId, order);
  }

  // Build the final list: respect `order`, fill empty groups for any tracked
  // VM that no longer has threads (group keeps its slot forever).
  const byId = new Map(groups.map((g) => [g.virtualMcpId, g] as const));
  return order.map((id) => {
    const existing = byId.get(id);
    if (existing) return existing;
    return {
      virtualMcpId: id,
      threads: [],
      latestUpdatedAt: "",
    } satisfies TaskGroupData;
  });
}
