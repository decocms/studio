import type { z } from "zod";

export interface PursuitContext {
  readonly tenant: string;
  readonly moverVersion: number;
  record(kind: string, payload?: unknown): Promise<void>;
  // The daimonion forbade this action; it was not applied. (See ../extensions/daimonion.)
  vetoed(kind: string, reason: string, payload?: unknown): Promise<void>;
  // A "user" action the engine cannot perform itself — surfaced for the human to
  // act on rather than applied. The deliberator that selected it calls this.
  suggest(kind: string, payload?: unknown): Promise<void>;
}

// Who may pick (and, for the engine, perform) an action:
//  - "user": only the human can do it; the engine surfaces it via ctx.suggest()
//    and never calls apply() (e.g. "connect an OAuth tool").
//  - "llm": only an LLM deliberator may pick it (it needs reasoning); the offline
//    rule planner skips it.
//  - "any": either the deterministic planner or the LLM may pick and apply it.
export type ActionAudience = "user" | "llm" | "any";

// A framework-agnostic "hand": the rule deliberator calls it via plan(), the AI
// deliberator wraps it as an LLM tool. Write it once; both paths use it.
export interface Action<P = unknown> {
  kind: string;
  description: string;
  // Defaults to "any" when omitted (back-compatible: picked + applied by both paths).
  audience?: ActionAudience;
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
