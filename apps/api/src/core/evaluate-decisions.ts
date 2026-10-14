import {
  experimental_evaluate,
  type Experimental_EvaluationQuestion,
  type Experimental_EvaluationResult,
} from "ai";
import type { StudioContext } from "./studio-context";
import type { SimpleModeModelSlot } from "@decocms/shared/sdk";
import {
  checkModelPermission,
  fetchModelPermissions,
} from "@/api/routes/decopilot/model-permissions";

/** Byte budget, deliberately conservative; this is not a tokenizer estimate. */
const MAX_DECISION_INPUT_BYTES = 24_000;

export function decisionInputFits(
  input: unknown,
  contextWindow: number,
): boolean {
  return (
    Number.isFinite(contextWindow) &&
    contextWindow > 0 &&
    new TextEncoder().encode(JSON.stringify(input)).byteLength <=
      Math.min(MAX_DECISION_INPUT_BYTES, Math.floor(contextWindow * 0.75))
  );
}

type DecisionInput<
  Questions extends Record<string, Experimental_EvaluationQuestion>,
> = {
  state: Parameters<typeof experimental_evaluate>[0]["state"];
  questions: Questions;
};

/** A decision model checked once for the caller's organization, so a caller
 *  can ask it many small questions for the price of one lookup. */
export interface DecisionModel {
  /** Whether `input` fits this model's conservative budget. */
  fits(input: unknown): boolean;
  evaluate<
    const Questions extends Record<string, Experimental_EvaluationQuestion>,
  >(
    input: DecisionInput<Questions>,
  ): Promise<Experimental_EvaluationResult<Questions>>;
}

/** Resolve credentials in the caller's organization, never through a chat tier. */
export async function openDecisionModel(
  ctx: StudioContext,
  selection: SimpleModeModelSlot,
): Promise<DecisionModel> {
  const org = ctx.organization;
  if (!org) throw new Error("Decision evaluation requires an organization");
  const allowed = await fetchModelPermissions(
    ctx.db,
    org.id,
    org.role ?? ctx.auth.user?.role,
  );
  if (!checkModelPermission(allowed, selection.keyId, selection.modelId)) {
    throw new Error("Decision model is not permitted for this role");
  }
  const models = await ctx.aiProviders.listDecisionModels(
    selection.keyId,
    org.id,
  );
  const model = models.find((entry) => entry.modelId === selection.modelId);
  if (!model?.capabilities.includes("decisions")) {
    throw new Error("Selected model does not support decisions");
  }
  const provider = await ctx.aiProviders.activate(selection.keyId, org.id);
  const decisions = provider.decisions;
  if (!decisions) throw new Error("Provider does not support decisions");
  const contextWindow = model.limits?.contextWindow ?? 0;
  const fits = (input: unknown) => decisionInputFits(input, contextWindow);
  const evaluate = <
    const Questions extends Record<string, Experimental_EvaluationQuestion>,
  >(
    input: DecisionInput<Questions>,
  ) => {
    if (!fits(input)) {
      throw new Error("Decision input exceeds the conservative context budget");
    }
    return experimental_evaluate({
      model: decisions.model(selection.modelId),
      ...input,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(10_000),
    });
  };
  return { fits, evaluate };
}
