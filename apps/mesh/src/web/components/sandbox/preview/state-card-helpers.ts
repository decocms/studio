import { PHASE_ORDER, type PhaseProgress } from "./derive-phase-progress";
import type { StateCardKind } from "./state-card-types";

export function headlineFor(kind: StateCardKind): string {
  switch (kind) {
    case "starting":
      return "Starting your sandbox";
    case "suspended":
      return "Sandbox is paused";
  }
}

/** The card index (0..3) the booting visual should show as active. */
export function activePhaseIndex(progress: PhaseProgress): 0 | 1 | 2 | 3 {
  return PHASE_ORDER.indexOf(progress.step) as 0 | 1 | 2 | 3;
}
