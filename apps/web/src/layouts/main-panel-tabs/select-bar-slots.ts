import { selectTabSlots } from "./select-tab-slots";

/** Hard cap on visible tab buttons; the shell narrows this further per width. */
export const MAX_VISIBLE = 3;

// Left-to-right priority for the lead buttons (before any user promotion).
// Overview (the agent's home view, when present) leads; then the source/edit
// views; Library ("files") trails them — it's a secondary overlay, so it must
// not outrank the agent's primary views.
const DEFAULT_LEAD_ORDER = ["overview", "preview", "content", "files"];

export interface BarSlotItem {
  id: string;
  active: boolean;
}

/**
 * Pure slotting for the main-panel button row: given the full item list, the
 * per-agent persisted promotions, the responsive cap and whether this is a code
 * agent, split into `visible` (bar) and `overflow` (stack popover).
 *
 * - Default order: `DEFAULT_LEAD_ORDER` leads, everything else keeps its
 *   natural order (stable sort).
 * - Persisted (user-promoted) ids lead, then the rest in default order; stale
 *   persisted ids (no longer present) are dropped.
 * - Code agents pin **Preview** and show the active view beside it; everything
 *   else overflows. Non-code agents delegate to `selectTabSlots`, which keeps
 *   the active item visible within `maxVisible`.
 */
export function selectBarSlots<T extends BarSlotItem>(input: {
  items: T[];
  persisted: string[];
  maxVisible: number;
  isCodeAgent: boolean;
}): { visible: T[]; overflow: T[] } {
  const { items, persisted, maxVisible, isCodeAgent } = input;

  const leadRank = (id: string) => {
    const i = DEFAULT_LEAD_ORDER.indexOf(id);
    return i === -1 ? DEFAULT_LEAD_ORDER.length : i;
  };
  const defaultOrdered = [...items].sort(
    (a, b) => leadRank(a.id) - leadRank(b.id),
  );

  const byId = new Map(defaultOrdered.map((i) => [i.id, i]));
  const persistedPresent = persisted.filter((id) => byId.has(id));
  const persistedSet = new Set(persistedPresent);
  const ordered: T[] = [
    ...persistedPresent.map((id) => byId.get(id)!),
    ...defaultOrdered.filter((i) => !persistedSet.has(i.id)),
  ];

  const effectiveMax = Math.max(1, Math.min(maxVisible, MAX_VISIBLE));
  const activeItem = items.find((i) => i.active);

  if (isCodeAgent) {
    const preview = ordered.find((i) => i.id === "preview");
    const lead = preview ? [preview] : [];
    const extra =
      activeItem && !lead.some((i) => i.id === activeItem.id)
        ? [activeItem]
        : [];
    const visible = [...lead, ...extra];
    const visibleIds = new Set(visible.map((i) => i.id));
    const overflow = ordered.filter((i) => !visibleIds.has(i.id));
    return { visible, overflow };
  }

  return selectTabSlots(ordered, activeItem?.id ?? null, effectiveMax);
}
