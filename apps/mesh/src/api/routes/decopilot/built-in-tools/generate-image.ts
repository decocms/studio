/**
 * generate_image Built-in Tool
 *
 * Server-side tool that generates images using the AI SDK's generateImage()
 * function. The image is written as a file part to the stream, and a short
 * text result is returned to the model.
 */

import type { MeshContext } from "@/core/mesh-context";
import type { MeshProvider } from "@/ai-providers/types";
import { monitorLlmCall } from "@/monitoring/emit-llm-call";
import { recordLlmCallMetrics } from "@/monitoring/record-llm-call-metrics";
import type { UIMessageStreamWriter } from "ai";
import { generateImage, tool, zodSchema } from "ai";
import { z } from "zod";
import type { ModelsConfig } from "../types";

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const GenerateImageInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(10_000)
    .describe(
      "Detailed description of the image to generate. Be specific about style, composition, colors, and subject.",
    ),
  aspect_ratio: z
    .enum(["1:1", "16:9", "9:16", "4:3", "3:4"])
    .optional()
    .describe("Aspect ratio for the generated image. Defaults to 1:1."),
});

const GENERATE_IMAGE_DESCRIPTION =
  "Generate an image from a text description. The generated image is displayed " +
  "inline to the user. Use this when the user asks you to create, draw, or " +
  "generate an image or picture.";

const GENERATE_IMAGE_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export interface GenerateImageParams {
  provider: MeshProvider;
  imageModelId: string;
  defaultAspectRatio?: string;
  models: ModelsConfig;
  organizationId: string;
  agentId: string;
  userId: string;
  threadId: string;
}

export function createGenerateImageTool(
  writer: UIMessageStreamWriter,
  params: GenerateImageParams,
  ctx: MeshContext,
) {
  const {
    provider,
    imageModelId,
    defaultAspectRatio,
    models,
    organizationId,
    agentId,
    userId,
    threadId,
  } = params;

  return tool({
    description: GENERATE_IMAGE_DESCRIPTION,
    inputSchema: zodSchema(GenerateImageInputSchema),
    execute: async ({ prompt, aspect_ratio }, { abortSignal, toolCallId }) => {
      const aspectRatio = (aspect_ratio ?? defaultAspectRatio ?? "1:1") as
        | `${number}:${number}`
        | undefined;

      const startTime = Date.now();

      try {
        const result = await generateImage({
          model: provider.aiSdk.imageModel(imageModelId),
          prompt,
          aspectRatio,
          abortSignal,
        });

        const durationMs = Date.now() - startTime;
        recordLlmCallMetrics({
          ctx,
          organizationId,
          modelId: imageModelId,
          durationMs,
          isError: false,
        });
        monitorLlmCall({
          ctx,
          organizationId,
          agentId,
          modelId: imageModelId,
          modelTitle: imageModelId,
          credentialId: models.credentialId,
          threadId,
          durationMs,
          isError: false,
          finishReason: "stop",
          userId,
          requestId: ctx.metadata.requestId,
          userAgent: ctx.metadata.userAgent ?? null,
        });

        const base64 = result.image.base64;
        const rawMediaType = result.image.mediaType ?? "image/png";
        if (!ALLOWED_IMAGE_TYPES.has(rawMediaType)) {
          throw new Error(`Unsupported generated image type: ${rawMediaType}`);
        }

        // Write the image as a file part directly to the stream
        writer.write({
          type: "file",
          url: `data:${rawMediaType};base64,${base64}`,
          mediaType: rawMediaType,
        });

        // Write tool metadata
        writer.write({
          type: "data-tool-metadata",
          id: toolCallId,
          data: {
            annotations: GENERATE_IMAGE_ANNOTATIONS,
            latencyMs: durationMs,
          },
        });

        return `Image generated successfully (${aspectRatio ?? "1:1"}).`;
      } catch (error) {
        // Don't record abort as an error
        if (abortSignal?.aborted) {
          throw error;
        }

        const durationMs = Date.now() - startTime;
        recordLlmCallMetrics({
          ctx,
          organizationId,
          modelId: imageModelId,
          durationMs,
          isError: true,
          errorType: error instanceof Error ? error.name : "Error",
        });
        monitorLlmCall({
          ctx,
          organizationId,
          agentId,
          modelId: imageModelId,
          modelTitle: imageModelId,
          credentialId: models.credentialId,
          threadId,
          durationMs,
          isError: true,
          errorMessage: error instanceof Error ? error.message : String(error),
          userId,
          requestId: ctx.metadata.requestId,
          userAgent: ctx.metadata.userAgent ?? null,
        });

        const errorMsg = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Image generation failed: ${errorMsg}. Try describing what you'd like to see as an image.`,
        );
      }
    },
  });
}
