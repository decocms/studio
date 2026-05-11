import {
  PHASE_ORDER,
  type PhaseKey,
  type PhaseProgress,
  type PhaseStatus,
} from "./derive-phase-progress";
import type { StateCardKind } from "./state-card-types";

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function phaseTickGlyph(status: PhaseStatus): "✓" | "✗" | "◐" | "○" {
  switch (status) {
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "doing":
      return "◐";
    case "pending":
      return "○";
  }
}

export function headlineFor(kind: StateCardKind): string {
  switch (kind) {
    case "never-started":
      return "Your sandbox is not running";
    case "starting-now":
      return "Starting your sandbox";
    case "errored":
      return "Sandbox failed to start";
    case "suspended":
      return "Sandbox is paused";
    case "crashed":
      return "Preview is unavailable";
  }
}

/**
 * Project a single PhaseProgress into the per-tick status for a given key.
 * Keys before the current step are "done"; the matching key carries the
 * current status; keys after are "pending".
 */
export function phaseStatusFor(
  progress: PhaseProgress,
  key: PhaseKey,
): PhaseStatus {
  const stepIdx = PHASE_ORDER.indexOf(progress.step);
  const keyIdx = PHASE_ORDER.indexOf(key);
  if (keyIdx < stepIdx) return "done";
  if (keyIdx > stepIdx) return "pending";
  return progress.status;
}

/** The card index (0..3) the booting visual should show as active. */
export function activePhaseIndex(progress: PhaseProgress): 0 | 1 | 2 | 3 {
  return PHASE_ORDER.indexOf(progress.step) as 0 | 1 | 2 | 3;
}
