/**
 * Split a flat tab list into visible (bar) and overflow (dropdown) slices.
 *
 * The active tab is always in `visible` — if it would otherwise live in
 * overflow, the last visible tab is displaced to the head of overflow and
 * the active tab is appended at the end of visible.
 */
export function selectTabSlots<T extends { id: string }>(
  tabs: T[],
  activeId: string | null,
  maxVisible: number,
): { visible: T[]; overflow: T[] } {
  if (tabs.length <= maxVisible) {
    return { visible: tabs, overflow: [] };
  }

  const visible = tabs.slice(0, maxVisible);
  const overflow = tabs.slice(maxVisible);

  if (activeId == null) {
    return { visible, overflow };
  }

  const activeInVisible = visible.some((t) => t.id === activeId);
  if (activeInVisible) {
    return { visible, overflow };
  }

  const activeIndexInOverflow = overflow.findIndex((t) => t.id === activeId);
  if (activeIndexInOverflow === -1) {
    return { visible, overflow };
  }

  const displaced = visible[visible.length - 1] as T;
  const promoted = overflow[activeIndexInOverflow] as T;
  const newVisible: T[] = [...visible.slice(0, -1), promoted];
  const newOverflow: T[] = [
    displaced,
    ...overflow.slice(0, activeIndexInOverflow),
    ...overflow.slice(activeIndexInOverflow + 1),
  ];
  return { visible: newVisible, overflow: newOverflow };
}
