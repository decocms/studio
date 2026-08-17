import type { PhaseKey, PhaseProgress } from "./derive-phase-progress";

// Exhaustive over `PhaseKey`, unlike the `.indexOf(...) as 0 | 1 | 2 | 3` cast it replaces.
const PHASE_INDEX: Record<PhaseKey, 0 | 1 | 2 | 3> = {
  provision: 0,
  cloning: 1,
  install: 2,
  dev: 3,
};

/** The card index (0..3) the booting visual should show as active. */
export function activePhaseIndex(progress: PhaseProgress): 0 | 1 | 2 | 3 {
  return PHASE_INDEX[progress.step];
}
