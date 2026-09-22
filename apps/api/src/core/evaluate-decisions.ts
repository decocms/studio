import {
  experimental_evaluate,
  type Experimental_EvaluationQuestion,
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

/** Resolve credentials in the caller's organization, never through a chat tier. */
export async function evaluateDecisions<
  const Questions extends Record<string, Experimental_EvaluationQuestion>,
>(
  ctx: StudioContext,
  selection: SimpleModeModelSlot,
  input: {
    state: Parameters<typeof experimental_evaluate>[0]["state"];
    questions: Questions;
  },
) {
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
  if (!decisionInputFits(input, model.limits?.contextWindow ?? 0)) {
    throw new Error("Decision input exceeds the conservative context budget");
  }
  const provider = await ctx.aiProviders.activate(selection.keyId, org.id);
  if (!provider.decisions)
    throw new Error("Provider does not support decisions");
  return experimental_evaluate({
    model: provider.decisions.model(selection.modelId),
    ...input,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(10_000),
  });
}
