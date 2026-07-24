import type { DropAnimation } from "@dnd-kit/core";

/**
 * Shared drop animation for our sortable DragOverlays.
 *
 * Why not the library default? With `dropAnimation={null}` the overlay clone is
 * removed the instant a drop fires, but dnd-kit clears its internal `active`
 * state one frame later — during that frame the dropped row is still
 * `opacity: 0` (its `isDragging` hasn't cleared yet) and the overlay is already
 * gone, so nothing paints at that spot and you see a one-frame blink. A short
 * drop animation keeps the clone alive across that gap.
 *
 * `sideEffects` is disabled on purpose: the default one drives the source
 * node's opacity imperatively, which fights our React-controlled
 * `opacity: isDragging ? 0` and would restore the row to opacity 0 when the
 * animation ends — moving the blink to the end instead of removing it. The
 * trade-off is that the reordered source row is revealed underneath while the
 * clone finishes its short travel into the same slot — the usual dnd-kit
 * "settle", acceptable because sortable rows reorder live under the cursor so
 * the clone lands right where it's dropped.
 *
 * Only for sortable lists whose dragged row is hidden with `opacity: 0`. The
 * home tile board is NOT one of these — it keeps its dragged tile at
 * `opacity-30` and runs its own CSS move transition on drop, so it passes
 * `dropAnimation={null}` instead.
 */
export const SORTABLE_DROP_ANIMATION: DropAnimation = {
  duration: 180,
  easing: "cubic-bezier(0.2, 0, 0, 1)",
  sideEffects: undefined,
};
