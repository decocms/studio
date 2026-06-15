/**
 * Demo Mode — autoplay loop.
 *
 * Plays each scenario in turn, pauses, resets, and advances — forever, until
 * the `AbortSignal` fires (on unmount). `onEnter(index)` is called right before
 * a scenario runs so the stage can swap to that scenario's layout. All
 * primitives reject with the signal's reason when aborted; we swallow those so
 * unmount is silent.
 */
import type { Director } from "./director";
import type { Scenario } from "./types";

/** Pause between the end of a scenario and the next one. */
const HANDOFF_PAUSE_MS = 3500;

export async function runAutoplay(
  director: Director,
  scenarios: Scenario[],
  signal: AbortSignal,
  onEnter: (index: number) => void,
): Promise<void> {
  let index = 0;
  while (!signal.aborted) {
    const i = index % scenarios.length;
    const scenario = scenarios[i]!;
    director.reset();
    onEnter(i);
    try {
      // Let the new layout mount before the first beat writes to its stores.
      await director.wait(250);
      await scenario.run(director);
      await director.wait(HANDOFF_PAUSE_MS);
    } catch {
      // Aborted (real unmount) or a scripted error — stop cleanly on abort.
      if (signal.aborted) return;
    }
    index++;
  }
}
