import type { Deliberator } from "./core";
import { isVetoError } from "./daimonion";

// Offline deliberation: run the domain's deterministic plan(). No LLM, no key.
export const ruleDeliberator: Deliberator = {
  async run({ domain, state, target, gap, ctx }) {
    const plan = domain.plan?.({ state, target, gap }) ?? [];
    const actionsTaken: string[] = [];

    for (const step of plan) {
      const action = domain.actions.find((a) => a.kind === step.kind);
      if (!action) continue;
      try {
        await action.apply(ctx.tenant, step.input);
        await ctx.record(action.kind, step.input);
        actionsTaken.push(action.kind);
      } catch (err) {
        if (!isVetoError(err)) throw err;
        await ctx.vetoed(action.kind, err.reason, step.input);
      }
    }

    return {
      summary: actionsTaken.length
        ? `rule planner applied: ${actionsTaken.join(", ")}`
        : "no applicable action",
      actionsTaken,
    };
  },
};
