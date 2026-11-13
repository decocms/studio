/**
 * generate_image — the Decopilot built-in's generation core, over the org's
 * `image` tier.
 *
 * The model gets the result JSON with each image's `studio-storage://` URI, as
 * Decopilot's did; the chat UI renders the image from it.
 *
 * Over MCP an app may also pick the model, an exact size and the provider's
 * quality and moderation. The chat built-in keeps the tier's model.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { FeatureNotInPlanError, orgHasFeature } from "@/core/plan-feature-gate";
import { resolveTier } from "@/core/resolve-tier";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import {
  GENERATE_IMAGE_DESCRIPTION,
  GenerateImageInputSchema,
  generateImageCore,
} from "@/harnesses/lib/decopilot/built-in-tools/portable-media-tools";
import { getSettings } from "@/settings";

const GenerateImageToolInputSchema = GenerateImageInputSchema.extend({
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Image model id on the provider of the organization's image tier, e.g. an OpenRouter slug. Defaults to the tier's model.",
    ),
  size: z
    .string()
    .regex(/^\d{2,4}x\d{2,4}$/)
    .optional()
    .describe("Exact output size, e.g. 1536x1920. Replaces aspectRatio."),
  quality: z.enum(["low", "medium", "high", "auto"]).optional(),
  moderation: z
    .enum(["low", "auto"])
    .optional()
    .describe("Moderation strictness of OpenAI image models."),
});

/** OpenRouter (and the deco gateway, built on it) copies these into the request body. */
const OPENROUTER_PROVIDER_IDS = new Set(["openrouter", "deco"]);

function imageProviderOptions(
  providerId: string,
  modelId: string,
  { quality, moderation }: { quality?: string; moderation?: string },
) {
  if (!quality && !moderation) return undefined;
  if (!OPENROUTER_PROVIDER_IDS.has(providerId)) {
    throw new Error(
      `quality and moderation need an OpenRouter image tier, not ${providerId}`,
    );
  }
  if (moderation && !modelId.startsWith("openai/")) {
    throw new Error("moderation applies to OpenAI image models only");
  }
  return {
    openrouter: {
      ...(quality ? { quality } : {}),
      // OpenRouter ignores a top-level `moderation`; OpenAI reads it here.
      ...(moderation
        ? { provider: { options: { openai: { moderation } } } }
        : {}),
    },
  };
}

const GenerateImageOutputSchema = z.object({
  success: z.literal(true),
  images: z.array(z.object({ uri: z.string(), mediaType: z.string() })),
  prompt: z.string(),
  model: z.string(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  usedReferenceImages: z.number(),
});

export const GENERATE_IMAGE = defineTool({
  name: "generate_image",
  description: GENERATE_IMAGE_DESCRIPTION,
  annotations: {
    title: "Generate Image",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: GenerateImageToolInputSchema,
  outputSchema: GenerateImageOutputSchema,
  requiresAiBudget: true,
  handler: async (input, ctx, call) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    if (!ctx.objectStorage) {
      throw new Error(
        "Object storage is unavailable; cannot persist the generated image.",
      );
    }
    const tier = await resolveTier(ctx, "image");
    const provider = await ctx.aiProviders.activate(
      tier.credentialId,
      organization.id,
    );
    const modelId = input.model ?? tier.modelId;
    // Below Ultra deco picks the model run on its gateway key.
    if (
      modelId !== tier.modelId &&
      provider.info.id === "deco" &&
      !(await orgHasFeature(ctx, organization.id, "model_choice"))
    ) {
      throw new FeatureNotInPlanError(
        "Choosing the image model needs the model_choice feature, which this organization's plan does not include",
        "model_choice",
      );
    }
    const providerOptions = imageProviderOptions(
      provider.info.id,
      modelId,
      input,
    );
    return generateImageCore(input, {
      provider,
      imageModelInfo: { id: modelId },
      objectStorage: ctx.objectStorage,
      ...(input.size ? { size: input.size as `${number}x${number}` } : {}),
      ...(providerOptions ? { providerOptions } : {}),
      allowHttpExternalUrls: getSettings().localMode,
      ...(call?.signal ? { abortSignal: call.signal } : {}),
    });
  },
});
