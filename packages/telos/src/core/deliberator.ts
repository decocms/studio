import type { Action, Domain, PursuitContext } from "./domain";

// The reasoning engine — swap rule-based <-> AI without touching the core.
export interface Deliberator {
  run<S, T, G>(args: {
    domain: Domain<S, T, G>;
    state: S;
    target: T;
    gap: G;
    ctx: PursuitContext;
    instructions: string;
    prompt: string;
  }): Promise<{ summary: string; actionsTaken: string[] }>;
}

// Thrown by a guarded action when a Daimonion forbids it (see ../extensions/daimonion).
// `applyAction` turns it into an eudaimon.action.vetoed event; deliberators that
// don't use `applyAction` should catch it the same way.
export class VetoError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`action vetoed: ${reason}`);
    this.name = "VetoError";
    this.reason = reason;
  }
}

export function isVetoError(err: unknown): err is VetoError {
  return err instanceof VetoError;
}

export type ActionOutcome =
  | { applied: true }
  | { applied: false; vetoed: string };

// Apply one action with veto handling — shared by every deliberator so the
// apply → record / veto → ctx.vetoed flow lives in exactly one place.
export async function applyAction(
  action: Action,
  ctx: PursuitContext,
  input: unknown,
): Promise<ActionOutcome> {
  try {
    await action.apply(ctx.tenant, input);
    await ctx.record(action.kind, input);
    return { applied: true };
  } catch (err) {
    if (!isVetoError(err)) throw err;
    await ctx.vetoed(action.kind, err.reason, input);
    return { applied: false, vetoed: err.reason };
  }
}
