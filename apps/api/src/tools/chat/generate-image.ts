/**
 * generate_image — the Decopilot built-in's generation core, over the org's
 * `image` tier.
 *
 * The model gets the result JSON with each image's `studio-storage://` URI, as
 * Decopilot's did; the chat UI renders the image from it.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { resolveTier } from "@/core/resolve-tier";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import {
  GENERATE_IMAGE_DESCRIPTION,
  GenerateImageInputSchema,
  generateImageCore,
} from "@/harnesses/lib/decopilot/built-in-tools/portable-media-tools";
import { getSettings } from "@/settings";

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
  inputSchema: GenerateImageInputSchema,
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
    return generateImageCore(input, {
      provider,
      imageModelInfo: { id: tier.modelId },
      objectStorage: ctx.objectStorage,
      allowHttpExternalUrls: getSettings().localMode,
      ...(call?.signal ? { abortSignal: call.signal } : {}),
    });
  },
});
