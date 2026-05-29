/**
 * Given an agent's typed slots and a map of app_id -> resolved connection id
 * (null when the caller has no matching connection), returns the slots that did
 * NOT resolve — i.e. the connections the caller must connect before the agent
 * can run.
 */
export interface SlotLike {
  slot_app_id: string;
}

export function unresolvedSlots<T extends SlotLike>(
  slots: T[],
  resolvedByAppId: Record<string, string | null>,
): T[] {
  return slots.filter((slot) => !resolvedByAppId[slot.slot_app_id]);
}
