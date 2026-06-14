// @decocms/telos/daimonion — the veto guardrail.
//
// Socrates' daimonion: an inner sign that is APOPHATIC — it never proposes an
// action, it only ever forbids the ones that lead away from the good. This is
// NOT the Eudaimon (the striving agent); it is the conscience that screens what
// the Eudaimon is about to do. Keep the two distinct: the Eudaimon drives, the
// Daimonion only ever says "no".

import type { Action, Awaitable, Domain } from "./core";

export interface Veto {
  reason: string;
}

// Return a Veto to forbid an action, or null to stay silent (allow). Never have
// it return an action to take — the moment it proposes, it stops being a
// guardrail and becomes a (worse) deliberator.
export interface Daimonion {
  veto(action: {
    kind: string;
    tenant: string;
    input: unknown;
  }): Awaitable<Veto | null>;
}

// Thrown by a guarded action when the daimonion forbids it. The built-in
// deliberators catch it, skip the action, and emit eudaimon.action.vetoed via
// ctx.vetoed(); a custom deliberator should do the same.
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

// Screen every action through the daimonion before its side effect runs. A
// forbidden action never applies. Composes over any Domain without the core or
// the deliberators knowing the conscience exists.
export function guardedBy(daimonion: Daimonion) {
  return <S, T, G>(domain: Domain<S, T, G>): Domain<S, T, G> => ({
    ...domain,
    actions: domain.actions.map((action) => guardAction(action, daimonion)),
  });
}

function guardAction<P>(action: Action<P>, daimonion: Daimonion): Action<P> {
  return {
    ...action,
    apply: async (tenant, input) => {
      const verdict = await daimonion.veto({
        kind: action.kind,
        tenant,
        input,
      });
      if (verdict) throw new VetoError(verdict.reason);
      await action.apply(tenant, input);
    },
  };
}
