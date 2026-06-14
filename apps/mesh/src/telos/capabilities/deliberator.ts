import { type Deliberator, ruleDeliberator } from "@decocms/telos";
import { aiDeliberator } from "@decocms/telos/ai";
import type { LanguageModel } from "ai";

// The model the agent MAY have this cycle; null means "no AI available now".
// Resolved per cycle (not at wire time) so AI is optional at RUNTIME.
export type ModelResolver = () =>
  | LanguageModel
  | null
  | Promise<LanguageModel | null>;

export interface AdaptiveDeliberatorOptions {
  resolveModel: ModelResolver;
  maxSteps?: number;
  maxActionsPerCycle?: number;
}

// Reason when we can, act from habit when we can't. Each cycle: resolve a model;
// if one is available let the AI deliberator drive, otherwise run the domain's
// deterministic plan() via ruleDeliberator. Both paths share the same domain
// Actions, so an action is written once and used by either. A domain with no
// actions has nothing to choose among, so we skip resolution and stay offline.
export function adaptiveDeliberator(
  opts: AdaptiveDeliberatorOptions,
): Deliberator {
  const { resolveModel, maxSteps, maxActionsPerCycle } = opts;
  return {
    async run(args) {
      const model = args.domain.actions.length ? await resolveModel() : null;
      const inner = model
        ? aiDeliberator({ model, maxSteps, maxActionsPerCycle })
        : ruleDeliberator;
      return inner.run(args);
    },
  };
}
