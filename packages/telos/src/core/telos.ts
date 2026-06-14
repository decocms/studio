import type { Awaitable } from "./awaitable";

// A purpose you hand an AGENT — not an agent itself. Where `Domain` + `Eudaimon`
// build a self-contained striver (its own loop, brain, and hands), a `Telos` is
// just the "what am I for" that an EXISTING agent carries: a host loop (e.g. an
// LLM harness) owns the deliberation and the tools; the telos rides along.
//
// Three faculties, only the charter is required:
//   - charter  — what the agent is FOR. Rendered into the host's system prompt.
//   - guard    — a conscience that forbids actions/tools betraying the purpose.
//   - measure  — observe the world and judge whether the purpose is met (and how far).
//
// The goal `T` is the frozen UnmovedMover target, read per agent from a GoalLedger
// (tenant = the agent's id). The telos never authors it — an authority installs it.
export interface Telos<T, S = unknown, G = unknown> {
  charter(goal: T): string;
  guard?: Guard;
  measure?: TelosMeasure<S, T, G>;
}

export interface TelosMeasure<S, T, G> {
  observe(tenant: string): Awaitable<S>;
  satisfied(state: S, goal: T): boolean;
  gap(state: S, goal: T): G;
}

// The conscience contract (apophatic): return a reason to forbid, null to allow.
// `@decocms/telos/daimonion`'s `Daimonion` satisfies this structurally; the tool
// guard (`guardTools`) consumes it. Lives in core so `Telos` references the port
// without importing the extension that implements it.
export interface Guard {
  veto(action: {
    kind: string;
    tenant: string;
    input: unknown;
  }): Awaitable<{ reason: string } | null>;
}

export type TelosProgress<G> =
  | { measured: false }
  | { measured: true; satisfied: boolean; gap: G };

// Measure an agent's world against its purpose — for a host that wants a
// done/progress signal. No-op (measured:false) when the telos doesn't measure.
export async function telosProgress<T, S, G>(
  telos: Telos<T, S, G>,
  goal: T,
  tenant: string,
): Promise<TelosProgress<G>> {
  if (!telos.measure) return { measured: false };
  const state = await telos.measure.observe(tenant);
  return {
    measured: true,
    satisfied: telos.measure.satisfied(state, goal),
    gap: telos.measure.gap(state, goal),
  };
}
