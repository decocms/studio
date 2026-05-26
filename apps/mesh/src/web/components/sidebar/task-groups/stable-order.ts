/**
 * Stable group ordering for the sidebar.
 *
 * The first non-empty render seeds an order for the org. Subsequent renders
 * reuse that order — task updates and reshuffles inside `groupThreadsByVirtualMcp`
 * don't move groups around. New groups (a VM that wasn't seen before) are
 * inserted immediately after Decopilot, so users notice them at the top
 * without disturbing the rest of the list.
 *
 * The cache is in-memory only (module-scoped) and resets on page refresh —
 * matches the "until next refresh" contract the UX asks for.
 */
import type { TaskGroupData } from "./group-threads";

const orderByOrg = new Map<string, string[]>();

export function stabilizeGroupOrder(
  orgId: string,
  groups: TaskGroupData[],
  decopilotVirtualMcpId: string | null,
): TaskGroupData[] {
  if (groups.length === 0) return groups;

  const existing = orderByOrg.get(orgId);

  // First non-empty render for this org — seed with current groupThreadsByVirtualMcp
  // order (Decopilot pinned, others by max(updated_at) desc).
  if (!existing || existing.length === 0) {
    orderByOrg.set(
      orgId,
      groups.map((g) => g.virtualMcpId),
    );
    return groups;
  }

  const known = new Set(existing);
  const newIds = groups
    .map((g) => g.virtualMcpId)
    .filter((id) => !known.has(id));

  // Splice new VMs in just after Decopilot, preserving everyone else's slot.
  let nextOrder = existing;
  if (newIds.length > 0) {
    const insertAt =
      decopilotVirtualMcpId && existing[0] === decopilotVirtualMcpId ? 1 : 0;
    nextOrder = [
      ...existing.slice(0, insertAt),
      ...newIds,
      ...existing.slice(insertAt),
    ];
    orderByOrg.set(orgId, nextOrder);
  }

  const byId = new Map(groups.map((g) => [g.virtualMcpId, g] as const));
  return nextOrder
    .map((id) => byId.get(id))
    .filter((g): g is TaskGroupData => !!g);
}
