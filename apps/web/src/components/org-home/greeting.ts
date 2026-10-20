/** The greeting the org home opens with. Pure, so the cutoffs are testable
 *  without a clock: the caller reads `new Date().getHours()` at render. */

export type GreetingSlot = "morning" | "afternoon" | "evening";

/** Morning before noon, afternoon before 18:00, evening after. */
export function greetingSlot(hour: number): GreetingSlot {
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/**
 * The first word of a person's name, or `null` when there is nothing usable.
 *
 * `null` is a real answer, not a failure: the bare greeting ("Good morning!")
 * is the copy for it. Never substitute a stand-in name.
 */
export function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first : null;
}

/** What the brief's sentence calls its window. */
export type PulseWindow = "overnight" | "today";

/** A morning reads the night; the rest of the day reads today. */
export function pulseWindow(slot: GreetingSlot): PulseWindow {
  return slot === "morning" ? "overnight" : "today";
}

/**
 * Where the brief's "what shipped" count starts. A morning reads the night
 * (from 18:00 yesterday); later in the day it reads today (from midnight).
 * Never a week: the sentence says "overnight" or "today" and must mean it.
 */
export function pulseWindowStart(slot: GreetingSlot, now: Date): number {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (slot === "morning") start.setHours(-6);
  return start.getTime();
}
