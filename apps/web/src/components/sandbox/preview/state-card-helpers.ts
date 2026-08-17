import { PHASE_ORDER } from "./derive-phase-progress";
import type { PhaseKey, PhaseProgress } from "./derive-phase-progress";

// Exhaustive over `PhaseKey`, derived from PHASE_ORDER to avoid manual duplication.
const PHASE_INDEX: Record<PhaseKey, 0 | 1 | 2 | 3> = Object.fromEntries(
  PHASE_ORDER.map((phase, index) => [phase, index]),
) as Record<PhaseKey, 0 | 1 | 2 | 3>;

/** The card index (0..3) the booting visual should show as active. */
export function activePhaseIndex(progress: PhaseProgress): 0 | 1 | 2 | 3 {
  return PHASE_INDEX[progress.step];
}
