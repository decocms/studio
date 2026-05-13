/**
 * Geometry and animation choreography for the "Reserving sandbox" booting
 * card's 8×6 capacity-rack visual. Pure data — no React imports — so it can
 * be unit-tested in isolation.
 *
 * Spec: .context/specs/2026-05-13-provision-card-rack-redesign-design.md
 */

/** Total tiles in the 8 cols × 6 rows rack. */
export const RACK_SLOT_COUNT = 48;

/**
 * Zero-based index of the persistently chart-1 "reserved" tile. Index 28 is
 * row 3, col 4 in an 8-column grid — just past the visual center, anchoring
 * the eye slightly below and right of dead-middle.
 */
export const RESERVED_SLOT_INDEX = 28;

/** Loop period of the scanner sweep, in seconds. */
export const RACK_SCAN_PERIOD_SEC = 3;

/**
 * Per-tile `animation-delay` for the scanner sweep, in seconds, or `null`
 * for the reserved tile (which does not participate in the sweep).
 *
 * Indexed by tile position 0..RACK_SLOT_COUNT-1. The reserved slot is
 * skipped from scan order, so the remaining tiles receive delays evenly
 * spaced across one RACK_SCAN_PERIOD_SEC loop, producing a chart-1
 * highlight that travels left→right, top→bottom across the rack.
 */
export const RACK_SCAN_DELAYS: ReadonlyArray<number | null> = (() => {
  const out: (number | null)[] = [];
  let scanOrder = 0;
  for (let i = 0; i < RACK_SLOT_COUNT; i++) {
    if (i === RESERVED_SLOT_INDEX) {
      out.push(null);
    } else {
      out.push((scanOrder / (RACK_SLOT_COUNT - 1)) * RACK_SCAN_PERIOD_SEC);
      scanOrder++;
    }
  }
  return out;
})();
