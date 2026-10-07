/**
 * generate_image — the Decopilot built-in's generation core, over the org's
 * `image` tier.
 *
 * The model gets the image itself as MCP image content (so it can look at what
 * it made) plus the result JSON with each image's `studio-storage://` URI, which
 * the chat UI renders from.
 */

import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { resolveTier } from "@/core/resolve-tier";
import {
  type StudioContext,
  requireAuth,
  requireOrganization,
} from "@/core/studio-context";
import {
  GENERATE_IMAGE_DESCRIPTION,
  GenerateImageInputSchema,
  generateImageCore,
} from "@/harnesses/lib/decopilot/built-in-tools/portable-media-tools";
import { parseStudioStorageKey } from "@/harnesses/lib/decopilot/studio-storage-uri";
import { getSettings } from "@/settings";

const GenerateImageOutputSchema = z.object({
  success: z.literal(true),
  images: z.array(z.object({ uri: z.string(), mediaType: z.string() })),
  prompt: z.string(),
  model: z.string(),
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  usedReferenceImages: z.number(),
});

async function imageContent(
  result: z.infer<typeof GenerateImageOutputSchema>,
  ctx: StudioContext,
): Promise<ContentBlock[]> {
  const objectStorage = ctx.objectStorage;
  const images = await Promise.all(
    result.images.map(async (image): Promise<ContentBlock[]> => {
      const key = parseStudioStorageKey(image.uri);
      if (key === null || !objectStorage) return [];
      // Stored either way: not showing it to the model must not fail the call.
      const bytes = await objectStorage.getBytes(key).catch(() => null);
      if (!bytes) return [];
      return [
        {
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: image.mediaType,
        },
      ];
    }),
  );
  return [{ type: "text", text: JSON.stringify(result) }, ...images.flat()];
}

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
  modelContent: imageContent,
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
