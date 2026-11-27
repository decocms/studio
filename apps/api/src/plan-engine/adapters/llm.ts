/**
 * The engine's Llm port on the org's AI providers: each class of model maps
 * to the org's chat tier of the same name, so the run uses (and bills) the
 * models the org already chose.
 */

import {
  generateText,
  type ImagePart,
  type LanguageModel,
  type TextPart,
} from "ai";
import { resolveTier, TierUnavailableError } from "@/core/resolve-tier";
import type { StudioContext } from "@/core/studio-context";
import {
  type Llm,
  type LlmContentPart,
  type LlmRequest,
  type LlmTier,
  type LlmUsage,
  NoAiModelError,
} from "../ports.ts";

const DEFAULT_TEMPERATURE = 0.3;
const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_TIMEOUT_MS = 60_000;

/** The answer stopped at `maxTokens`; retrying the same call truncates again. */
export class LlmTruncatedError extends Error {
  constructor(maxTokens: number) {
    super(
      `a resposta do modelo foi cortada em maxTokens=${maxTokens}: aumente o limite ou encurte o prompt`,
    );
    this.name = "LlmTruncatedError";
  }
}

/** The org's tier for this class; `thinking` falls back to `smart` when unset. */
async function tierModel(ctx: StudioContext, tier: LlmTier) {
  try {
    return await resolveTier(ctx, tier);
  } catch (err) {
    if (!(err instanceof TierUnavailableError)) throw err;
  }
  if (tier === "thinking") {
    try {
      return await resolveTier(ctx, "smart");
    } catch (err) {
      if (!(err instanceof TierUnavailableError)) throw err;
    }
  }
  throw new NoAiModelError();
}

/** Whether the org has the `smart` model every run needs; any other failure throws. */
export async function hasEngineModel(ctx: StudioContext): Promise<boolean> {
  try {
    await resolveTier(ctx, "smart");
    return true;
  } catch (err) {
    if (err instanceof TierUnavailableError) return false;
    throw err;
  }
}

const toPart = (p: LlmContentPart): TextPart | ImagePart =>
  p.type === "text"
    ? { type: "text", text: p.text }
    : { type: "image", image: new URL(p.url) };

/** What the provider says the call cost, when it says (OpenRouter-style). */
function reportedCost(metadata: unknown): number | undefined {
  const cost = (
    metadata as { openrouter?: { usage?: { cost?: unknown } } } | undefined
  )?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : undefined;
}

/**
 * One engine request on a resolved model. Shared by the org adapter below and
 * the offline replay (apps/api/scripts/plan-ux-eval.ts).
 */
export async function callModel(
  model: { languageModel: LanguageModel; provider: string; modelId: string },
  request: LlmRequest,
  onUsage?: (usage: LlmUsage) => void,
): Promise<string> {
  const maxTokens = request.maxTokens ?? DEFAULT_MAX_TOKENS;
  const content: Array<TextPart | ImagePart> = [
    { type: "text", text: request.userPrompt },
    ...(request.contentParts ?? []).map(toPart),
  ];
  const result = await generateText({
    model: model.languageModel,
    system: request.systemPrompt,
    messages: [{ role: "user", content }],
    temperature: request.temperature ?? DEFAULT_TEMPERATURE,
    maxOutputTokens: maxTokens,
    abortSignal: AbortSignal.timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  // Before validating: a truncated or empty answer was still billed.
  const costUsd = reportedCost(result.providerMetadata);
  onUsage?.({
    provider: model.provider,
    model: model.modelId,
    promptTokens: result.usage.inputTokens ?? 0,
    completionTokens: result.usage.outputTokens ?? 0,
    ...(costUsd !== undefined ? { costUsd } : {}),
  });
  if (result.finishReason === "length") throw new LlmTruncatedError(maxTokens);
  if (!result.text) throw new Error("o modelo devolveu uma resposta vazia");
  return result.text;
}

/** `ctx` must carry the run's organization (and the member it runs as). */
export function orgLlm(ctx: StudioContext): Llm {
  return async (request, onUsage) => {
    const orgId = ctx.organization?.id;
    if (!orgId) throw new Error("the engine's model call has no organization");
    const { credentialId, modelId } = await tierModel(ctx, request.tier);
    const provider = await ctx.aiProviders.activate(credentialId, orgId);
    return callModel(
      {
        languageModel: provider.aiSdk.languageModel(modelId),
        provider: provider.info.id,
        modelId,
      },
      request,
      onUsage,
    );
  };
}
