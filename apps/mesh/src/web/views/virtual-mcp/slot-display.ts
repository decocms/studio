/**
 * Decides how to display a typed slot. A slot carries only a `slot_app_id`;
 * when it resolves to one of the caller's connections we show that connection's
 * title/icon, otherwise we fall back to the raw app_id (the "not connected for
 * you" state).
 */
export interface SlotDisplay {
  state: "resolved" | "unresolved";
  title: string;
  icon: string | null;
}

export function slotDisplayState(
  slotAppId: string,
  resolved: { title: string; icon: string | null } | null,
): SlotDisplay {
  if (resolved) {
    return { state: "resolved", title: resolved.title, icon: resolved.icon };
  }
  return { state: "unresolved", title: slotAppId, icon: null };
}
