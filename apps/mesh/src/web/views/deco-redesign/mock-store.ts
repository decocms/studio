// Tiny shared store for the mockup so the home, sidebar, and incident task all
// reflect the same finding states (approve in the task → sidebar + home update).
// Mock only — the real product reads this from threads/findings, not a module var.
import { useSyncExternalStore } from "react";
import type { AutonomyMode, IncidentState } from "./mock-data";

let overrides: Record<string, IncidentState> = {};
let goalAutonomy: Record<string, AutonomyMode> = {};
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function setIncidentState(id: string, state: IncidentState) {
  overrides = { ...overrides, [id]: state };
  for (const l of listeners) l();
}

export function useOverrides(): Record<string, IncidentState> {
  return useSyncExternalStore(
    subscribe,
    () => overrides,
    () => overrides,
  );
}

/** Per-goal autonomy overrides (Inform / Propose / Auto) — the dial on the home
 *  goal cards + the goal detail write here so both surfaces stay in sync. */
export function setGoalAutonomy(id: string, mode: AutonomyMode) {
  goalAutonomy = { ...goalAutonomy, [id]: mode };
  for (const l of listeners) l();
}

export function useGoalAutonomy(): Record<string, AutonomyMode> {
  return useSyncExternalStore(
    subscribe,
    () => goalAutonomy,
    () => goalAutonomy,
  );
}
