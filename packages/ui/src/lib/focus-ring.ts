/**
 * The keyboard focus ring worn by every button in a panel header — drawn
 * INSIDE the element's border box.
 *
 * Outside it, a ring is shaved off by any `overflow-hidden` ancestor, and a
 * panel header is full of them: its tab group's content box starts flush with
 * the first button's left edge, so that button's ring rendered with one side
 * missing while its neighbours looked whole. Inside the box there is nothing
 * left to clip, and the ring is the same shape on every button in the row.
 *
 * `ring-0` and `border-border` are here to neutralise the outset ring the
 * `Button` variants bring; both are inert on a bare `<button>`, so one string
 * covers every kind of button a header holds.
 *
 * Forced colors (Windows High Contrast) paint no box-shadow, so the inset ring
 * is invisible there and the outline it replaces must come back. Hence
 * `not-forced-colors:` on the suppression rather than a plain `outline-none`:
 * `outline-none` sets `outline-style: none`, which a `forced-colors:outline-2`
 * added alongside it cannot reliably override (same specificity, cascade order
 * decides). Scoped off, the 2px outline below is the only rule in play.
 */
export const INSET_FOCUS_RING =
  "focus-visible:not-forced-colors:outline-none focus-visible:forced-colors:outline-2 focus-visible:forced-colors:outline-offset-0 focus-visible:ring-0 focus-visible:border-border focus-visible:inset-ring-2 focus-visible:inset-ring-ring/50";
