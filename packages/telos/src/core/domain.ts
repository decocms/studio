import type { z } from "zod";

export interface PursuitContext {
  readonly tenant: string;
  readonly moverVersion: number;
  record(kind: string, payload?: unknown): Promise<void>;
  // The daimonion forbade this action; it was not applied. (See ../socratic/daimonion.)
  vetoed(kind: string, reason: string, payload?: unknown): Promise<void>;
}

// A framework-agnostic "hand": the rule deliberator calls it via plan(), the AI
// deliberator wraps it as an LLM tool. Write it once; both paths use it.
export interface Action<P = unknown> {
  kind: string;
  description: string;
  schema: z.ZodType<P>;
  apply(tenant: string, input: P): Promise<void>;
}

export interface Domain<S, T, G = unknown> {
  readonly name: string;
  observe(tenant: string): Promise<S>;
  satisfied(state: S, target: T): boolean;
  gap(state: S, target: T): G;
  readonly instructions: string;
  readonly actions: Action[];
  prompt(input: {
    state: S;
    target: T;
    gap: G;
    tenant: string;
    moverVersion: number;
  }): string;
  // Deterministic steps so the rule deliberator can run without an LLM.
  plan?(input: {
    state: S;
    target: T;
    gap: G;
  }): Array<{ kind: string; input: unknown }>;
}
