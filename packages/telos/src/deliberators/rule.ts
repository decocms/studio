import { applyAction, type Deliberator } from "../core";

// Offline deliberation: run the domain's deterministic plan(). No LLM, no key.
export const ruleDeliberator: Deliberator = {
  async run({ domain, state, target, gap, ctx }) {
    const plan = domain.plan?.({ state, target, gap }) ?? [];
    const actionsTaken: string[] = [];

    for (const step of plan) {
      const action = domain.actions.find((a) => a.kind === step.kind);
      if (!action) continue;
      const outcome = await applyAction(action, ctx, step.input);
      if (outcome.applied) actionsTaken.push(action.kind);
    }

    return {
      summary: actionsTaken.length
        ? `rule planner applied: ${actionsTaken.join(", ")}`
        : "no applicable action",
      actionsTaken,
    };
  },
};
