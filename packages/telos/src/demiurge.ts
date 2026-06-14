// @decocms/telos/demiurge — the transcendent ideal you only ever approach.
//
// SPECULATIVE: interface only. There is no implementation and no consumer yet —
// this reserves the shape until the first Platonic feature is real. Do not build
// against it expecting behavior.
//
// Platonic metaphysics, distinct from the Aristotelian core: one transcendent,
// SHARED ideal (the Form) that every tenant's world participates in imperfectly,
// forever. Unlike an UnmovedMover (immanent, per-tenant, reachable), a Form is
// singular and timeless — you never arrive, you only resemble it more. So
// `participation` (a degree, 0..1) replaces `satisfied` (a boolean): you approach
// a transcendent end, you do not reach it.

export interface Form<S> {
  readonly name: string;
  // 0..1 — degree of resemblance to the ideal. Approached, never 1.
  participation(state: S): number;
}

// The craftsman of Plato's Timaeus: gazes at the Form and shapes matter toward
// its likeness, on a cadence. It is never "done".
export interface Demiurge<S> {
  craft(state: S): Promise<void>;
}
