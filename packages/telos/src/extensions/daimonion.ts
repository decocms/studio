// @decocms/telos/daimonion — the veto guardrail.
//
// Socrates' daimonion: an inner sign that is APOPHATIC — it never proposes an
// action, it only ever forbids the ones that lead away from the good. This is
// NOT the Eudaimon (the striving agent); it is the conscience that screens what
// the Eudaimon is about to do. Keep the two distinct: the Eudaimon drives, the
// Daimonion only ever says "no".

import { type Action, type Awaitable, type Domain, VetoError } from "../core";

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

// Screen every action through the daimonion before its side effect runs. A
// forbidden action throws VetoError (which the deliberators turn into an
// eudaimon.action.vetoed event); it composes over any Domain without the core or
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

// The tool-level analog of `guardedBy`, for screening a HOST agent's tools (an LLM
// harness's toolset) rather than a Domain's actions. Each tool's `execute` runs
// the daimonion first; a forbidden call never executes and, unlike an Action veto,
// RETURNS a result string instead of throwing — so the host's tool loop keeps
// going and the model sees it was refused and adapts. AI-free: the toolset is
// typed structurally (`Record<string, unknown>`), so an AI SDK `ToolSet` drops in
// without importing `ai`; the per-tool shape is narrowed internally.
type ExecutableTool = {
  execute?: (input: unknown, options: unknown) => unknown;
};

export function guardTools<TS extends Record<string, unknown>>(
  tools: TS,
  daimonion: Daimonion,
  tenant: string,
): TS {
  const guarded: Record<string, unknown> = {};
  for (const [kind, value] of Object.entries(tools)) {
    const t = value as ExecutableTool;
    if (typeof t.execute !== "function") {
      guarded[kind] = value;
      continue;
    }
    const execute = t.execute.bind(t);
    guarded[kind] = {
      ...(value as object),
      execute: async (input: unknown, options: unknown) => {
        const verdict = await daimonion.veto({ kind, tenant, input });
        if (verdict) return `Action vetoed (${kind}): ${verdict.reason}`;
        return execute(input, options);
      },
    };
  }
  return guarded as TS;
}
