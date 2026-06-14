import { applyAction, type Deliberator } from "../core";

// Offline deliberation: run the domain's deterministic plan(). No LLM, no key.
// Routes each planned step by audience: applies "any", surfaces "user" actions as
// suggestions (the engine can't perform them), and skips "llm" (it needs reasoning
// the offline planner doesn't have).
export const ruleDeliberator: Deliberator = {
  async run({ domain, state, target, gap, ctx }) {
    const plan = domain.plan?.({ state, target, gap }) ?? [];
    const applied: string[] = [];
    const suggested: string[] = [];

    for (const step of plan) {
      const action = domain.actions.find((a) => a.kind === step.kind);
      if (!action) continue;
      const audience = action.audience ?? "any";
      if (audience === "llm") continue;
      if (audience === "user") {
        await ctx.suggest(action.kind, step.input);
        suggested.push(action.kind);
        continue;
      }
      const outcome = await applyAction(action, ctx, step.input);
      if (outcome.applied) applied.push(action.kind);
    }

    const parts: string[] = [];
    if (applied.length) parts.push(`applied: ${applied.join(", ")}`);
    if (suggested.length)
      parts.push(`suggested to user: ${suggested.join(", ")}`);

    return {
      summary: parts.length
        ? `rule planner ${parts.join("; ")}`
        : "no applicable action",
      actionsTaken: applied,
    };
  },
};
