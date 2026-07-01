/** Pure selection math for the interactive link table. */

export function orderedHandles(
  sandboxes: Map<string, { handle: string }>,
): string[] {
  return [...sandboxes.values()]
    .map((r) => r.handle)
    .sort((a, b) => a.localeCompare(b));
}

export function nextSelection(
  handles: string[],
  current: string | null,
  delta: 1 | -1,
): string | null {
  if (handles.length === 0) return null;
  const idx = current === null ? -1 : handles.indexOf(current);
  if (idx === -1) return delta > 0 ? handles[0]! : handles[handles.length - 1]!;
  const clamped = Math.max(0, Math.min(handles.length - 1, idx + delta));
  return handles[clamped]!;
}

export function selectionAfterRemoval(
  handles: string[],
  removed: string,
  current: string | null,
): string | null {
  if (current !== removed) return current;
  const idx = handles.indexOf(removed);
  if (idx === -1) return current;
  return handles[idx + 1] ?? handles[idx - 1] ?? null;
}
