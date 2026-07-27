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
 * - Code agents pin **Preview** and show the active view beside it; a view
 *   configured as the default main view (`leadId`, e.g. Content) is pinned
 *   ahead of Preview. Everything else overflows. Non-code agents delegate to
 *   `selectTabSlots`, which keeps the active item visible within `maxVisible`.
 */
export function selectBarSlots<T extends BarSlotItem>(input: {
  items: T[];
  persisted: string[];
  maxVisible: number;
  isCodeAgent: boolean;
  /**
   * The tab configured as the agent's default main view (its landing view).
   * When set, it leads the bar — the view the user chose to land on is pinned
   * up front — but never ahead of Overview (the agent's home) and always below
   * an explicit user promotion (`persisted`).
   */
  leadId?: string | null;
}): { visible: T[]; overflow: T[] } {
  const { items, persisted, maxVisible, isCodeAgent, leadId } = input;

  const leadRank = (id: string) => {
    const i = DEFAULT_LEAD_ORDER.indexOf(id);
    const rank = i === -1 ? DEFAULT_LEAD_ORDER.length : i;
    // The configured default main view leads the row, but Overview (rank 0)
    // stays the agent's home when present, so slot the lead just after it.
    if (leadId && id === leadId && id !== "overview") return 0.5;
    return rank;
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
    // Preview is the code agent's hallmark pinned view; when a different view
    // is configured as the default main view (e.g. Content), pin it *ahead* of
    // Preview so the landing view the user chose reads first. The active view
    // then shows beside them; everything else overflows.
    const preview = ordered.find((i) => i.id === "preview");
    const leadItem =
      leadId && leadId !== "preview"
        ? ordered.find((i) => i.id === leadId)
        : undefined;
    const lead = [leadItem, preview].filter((i): i is T => !!i);
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
