/**
 * Demo Mode — play-once runner.
 *
 * Plays the scenario once, then shows the end card and waits for the viewer to
 * click "Replay" (no silent auto-loop). All primitives reject with the signal's
 * reason on abort; we swallow those so a real unmount is silent.
 */
import type { Director } from "./director";
import type { Scenario } from "./types";

export async function runAutoplay(
  director: Director,
  scenarios: Scenario[],
  signal: AbortSignal,
  onEnter: (index: number) => void,
): Promise<void> {
  const scenario = scenarios[0];
  if (!scenario) return;

  while (!signal.aborted) {
    director.reset();
    onEnter(0);
    try {
      // Let the layout mount before the first beat writes to its stores.
      await director.wait(300);
      await scenario.run(director);
    } catch {
      if (signal.aborted) return;
    }
    if (signal.aborted) return;
    director.markEnded();
    await director.awaitReplay();
  }
}
