/**
 * generate_text — one completion on the organization's chat models, for apps.
 *
 * generate_image gives an app the org's image models without a key of its own;
 * this is the same for text, and for reading images (a vision model describing
 * product photos). By default it runs on the org's `smart` tier, the model the
 * chat uses, and spends the org's AI allowance like the chat does. An app may
 * pick another chat tier, or a provider key and model, as with generate_image.
 */

import { type FilePart, generateText, type TextPart } from "ai";
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { FeatureNotInPlanError, orgHasFeature } from "@/core/plan-feature-gate";
import { resolveTier } from "@/core/resolve-tier";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import { fetchImageBytes } from "@/harnesses/lib/decopilot/built-in-tools/portable-media-tools";
import { getSettings } from "@/settings";
import { providerKeyId } from "./generate-image";

const MAX_IMAGES = 10;

const GenerateTextInputSchema = z.object({
  prompt: z.string().min(1).max(100_000).describe("The user message."),
  system: z
    .string()
    .max(20_000)
    .optional()
    .describe("Instructions placed before the message."),
  images: z
    .array(z.object({ uri: z.string().min(1).max(4_000) }))
    .max(MAX_IMAGES)
    .optional()
    .describe(
      "Images sent with the message, for a model that reads images: https URLs, studio-storage:// URIs or data: URIs.",
    ),
  tier: z
    .enum(["fast", "smart", "thinking"])
    .optional()
    .describe("The org's chat tier to run on. Defaults to smart."),
  provider: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Run on the organization's key of this AI provider (e.g. openrouter) instead of the tier's. Needs `model`.",
    ),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Model id on that provider, e.g. an OpenRouter slug. Defaults to the tier's model.",
    ),
  maxOutputTokens: z.number().int().min(1).max(32_000).optional(),
});

const GenerateTextOutputSchema = z.object({
  success: z.literal(true),
  text: z.string(),
  model: z.string(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
});

export const GENERATE_TEXT = defineTool({
  name: "generate_text",
  description:
    "Generate text with the organization's chat model, optionally reading images (e.g. describe product photos). Returns the model's text. Runs on the org's smart tier unless a tier, or a provider key and model, is given.",
  annotations: {
    title: "Generate Text",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: GenerateTextInputSchema,
  outputSchema: GenerateTextOutputSchema,
  requiresAiBudget: true,
  handler: async (input, ctx, call) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    let credentialId: string;
    let modelId: string;
    let tierModelId: string | null = null;
    if (input.provider) {
      if (!input.model) throw new Error("provider needs a model");
      credentialId = await providerKeyId(ctx, organization.id, input.provider);
      modelId = input.model;
    } else {
      const tier = await resolveTier(ctx, input.tier ?? "smart");
      credentialId = tier.credentialId;
      tierModelId = tier.modelId;
      modelId = input.model ?? tier.modelId;
    }
    const provider = await ctx.aiProviders.activate(
      credentialId,
      organization.id,
    );
    // Below Ultra deco picks the model run on its gateway key.
    if (
      modelId !== tierModelId &&
      provider.info.id === "deco" &&
      !(await orgHasFeature(ctx, organization.id, "model_choice"))
    ) {
      throw new FeatureNotInPlanError(
        "Choosing the model needs the model_choice feature, which this organization's plan does not include",
        "model_choice",
      );
    }

    // Fetched here, through the same guards as generate_image's references
    // (https, no private addresses, size cap), rather than handed to the
    // provider as URLs it would fetch itself.
    const images: FilePart[] = await Promise.all(
      (input.images ?? []).map(async ({ uri }) => ({
        type: "file" as const,
        // The SDK reads the exact image type from the bytes.
        mediaType: "image",
        data: await fetchImageBytes(uri, {
          objectStorage: ctx.objectStorage,
          allowHttpExternalUrls: getSettings().localMode,
          ...(call?.signal ? { abortSignal: call.signal } : {}),
        }),
      })),
    );
    const text: TextPart = { type: "text", text: input.prompt };

    const result = await generateText({
      model: provider.aiSdk.languageModel(modelId),
      ...(input.system ? { system: input.system } : {}),
      messages: [{ role: "user", content: [text, ...images] }],
      ...(input.maxOutputTokens
        ? { maxOutputTokens: input.maxOutputTokens }
        : {}),
      ...(call?.signal ? { abortSignal: call.signal } : {}),
    });

    return {
      success: true as const,
      text: result.text,
      model: modelId,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
    };
  },
});
