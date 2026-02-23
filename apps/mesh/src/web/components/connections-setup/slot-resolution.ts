import type { ConnectionEntity } from "@decocms/mesh-sdk";

export type SlotPhase =
  | "loading"
  | "picker"
  | "install"
  | "polling"
  | "auth-oauth"
  | "auth-token"
  | "done";

export function findMatchingConnections(
  connections: ConnectionEntity[],
  itemId: string,
): ConnectionEntity[] {
  return connections.filter(
    (c) =>
      (c.metadata as Record<string, unknown> | null)?.registry_item_id ===
      itemId,
  );
}

export function resolveInitialPhase(
  connections: ConnectionEntity[],
  itemId: string,
): "done" | "picker" | "install" {
  const matches = findMatchingConnections(connections, itemId);
  if (matches.length === 0) return "install";
  const hasActive = matches.some((c) => c.status === "active");
  return hasActive ? "done" : "picker";
}
