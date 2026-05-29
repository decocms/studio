/**
 * Decide how a connection should be attached to a Virtual MCP / agent based on
 * its visibility (`access`).
 *
 * Org-scoped connections (`access === "org"`) attach as concrete children — the
 * agent references the exact connection id. User-private connections
 * (`access === "user"`) must attach as typed *slots*: at runtime the slot is
 * resolved per-caller to that caller's own connection of the matching app_id
 * (falling back to an org-shared one). A private connection without an `app_id`
 * has no type to slot on, so it can't be attached.
 *
 * Shared by the agent settings tab (`handleAddConnection`) and the bulk
 * "add to agent" flow so the slot-vs-child decision stays in one place.
 */
export type AttachTarget =
  | { kind: "connection"; connectionId: string }
  | { kind: "slot"; slotAppId: string }
  | { kind: "skip-no-app-id" };

export function connectionAttachTarget(conn: {
  id: string;
  access: "user" | "org";
  app_id?: string | null;
}): AttachTarget {
  if (conn.access === "user") {
    if (!conn.app_id) return { kind: "skip-no-app-id" };
    return { kind: "slot", slotAppId: conn.app_id };
  }
  return { kind: "connection", connectionId: conn.id };
}
