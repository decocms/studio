/**
 * generate_image Built-in Tool
 *
 * Server-side tool that generates images using the selected image model.
 * Uses AI SDK generateImage() with the provider's imageModel().
 *
 * The base64 image data is written to the UI stream as a data part
 * (keyed by toolCallId) so the renderer can display it. The tool result
 * returned to the model is a lightweight text summary to avoid blowing
 * up the context window.
 *
 * Supports reference images: the AI can pass base64-encoded images from
 * the conversation as references for image-to-image generation.
 */

import { tool, zodSchema, generateImage, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { MeshProvider } from "@/ai-providers/types";
import type { ModelInfo } from "../types";

const GenerateImageInputSchema = z.object({
  prompt: z
    .string()
    .max(10000)
    .describe(
      "Detailed description of the image to generate. Be specific about style, composition, colors, and subject matter.",
    ),
  referenceImages: z
    .array(
      z.object({
        base64: z.string().describe("Base64-encoded image data"),
        mediaType: z
          .string()
          .default("image/png")
          .describe("MIME type of the image (e.g. image/png, image/jpeg)"),
      }),
    )
    .optional()
    .describe(
      "Reference images from the conversation to use as input for image-to-image generation. " +
        "Extract these from user-attached files in the conversation when the user wants to " +
        "modify, transform, or use an existing image as a starting point.",
    ),
  aspectRatio: z
    .enum(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"])
    .optional()
    .describe("Aspect ratio for the generated image. Defaults to 1:1."),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Number of images to generate. Defaults to 1."),
});

export type GenerateImageInput = z.infer<typeof GenerateImageInputSchema>;

export interface GenerateImageDataPart {
  toolCallId: string;
  images: Array<{ base64: string; mediaType: string }>;
  prompt: string;
}

export function createGenerateImageTool(params: {
  provider: MeshProvider;
  imageModelInfo: ModelInfo;
  writer: UIMessageStreamWriter;
}) {
  const { provider, imageModelInfo, writer } = params;

  return tool({
    description:
      "Generate an image from a text description, optionally using reference images. " +
      "Use this when the user asks you to create, generate, draw, or design an image. " +
      "If the user has attached images and wants to modify or use them as a reference, " +
      "pass them as referenceImages. " +
      "The image is displayed automatically by the UI — do NOT include image URLs or markdown images in your response.",
    inputSchema: zodSchema(GenerateImageInputSchema),
    execute: async (input, { toolCallId }) => {
      const imageModel = provider.aiSdk.imageModel(imageModelInfo.id);

      // Build the prompt: text-only or text + reference images
      const hasRefs = input.referenceImages && input.referenceImages.length > 0;
      const prompt = hasRefs
        ? {
            text: input.prompt,
            images: input.referenceImages!.map((ref) => ref.base64),
          }
        : input.prompt;

      const result = await generateImage({
        model: imageModel,
        prompt,
        n: input.n ?? 1,
        ...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
      });

      const images = result.images.map((img) => ({
        base64: img.base64,
        mediaType: img.mediaType ?? "image/png",
      }));

      // Write the full image data to the UI stream as a data part.
      // This keeps it out of the tool result (which goes back to the model).
      writer.write({
        type: "data-generate-image" as "data-generate-image",
        data: { toolCallId, images, prompt: input.prompt },
      });

      // Return a lightweight summary — this is what the model sees.
      return {
        success: true,
        imageCount: images.length,
        prompt: input.prompt,
        usedReferenceImages: hasRefs ? input.referenceImages!.length : 0,
      };
    },
  });
}
