/**
 * take_screenshot Built-in Tool
 *
 * Server-side tool that captures a JPEG screenshot of a web page using
 * Browserless v2 cloud API. Requires the BROWSERLESS_TOKEN env var.
 *
 * The screenshot is uploaded to object storage and injected into the
 * conversation as a user message via `pendingImages` + `prepareStep`,
 * bypassing provider-specific limitations with images in tool results.
 */

import { tool, zodSchema, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { MeshContext } from "@/core/mesh-context";
import { toMeshStorageUri } from "../mesh-storage-uri";
import { generatePresignedGetUrl } from "../file-materializer";
import { BROWSERLESS_BASE_URL } from "./constants";

/**
 * Default viewport for screenshots. 1280x800 gives a reasonable desktop
 * view while staying well under the 1568px optimal limit for Claude's
 * vision processing.
 */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** JPEG quality for screenshots (0-100). Lower = smaller payload. */
const JPEG_QUALITY = 80;

const TakeScreenshotInputSchema = z.object({
  url: z.string().url().describe("The URL of the web page to screenshot."),
  fullPage: z
    .boolean()
    .optional()
    .describe(
      "When true, captures the full scrollable page instead of just the viewport. Defaults to false.",
    ),
});

export type TakeScreenshotInput = z.infer<typeof TakeScreenshotInputSchema>;

/**
 * Pending image entry. Stored by `execute`, consumed by `prepareStep`
 * in stream-core.ts which injects it as a user message content part.
 *
 * One of `pageUrl` or `label` should be set; `label` takes precedence
 * when present. Screenshots use `pageUrl` (preserving the legacy
 * `[Screenshot of <url>]` framing); other sources (e.g. `view` loading
 * a sandbox image) set `label` directly.
 */
export interface PendingImage {
  url: string;
  mediaType: string;
  pageUrl?: string;
  label?: string;
}

export function createTakeScreenshotTool(
  writer: UIMessageStreamWriter,
  params: {
    ctx: MeshContext;
    toolOutputMap: Map<string, string>;
    pendingImages: PendingImage[];
  },
) {
  const { ctx, toolOutputMap, pendingImages } = params;

  return tool({
    description:
      "Take a screenshot of a web page. " +
      "Use this when you need to visually see a website, check its layout, " +
      "verify a deployment, or inspect a page's appearance. " +
      "The screenshot is displayed automatically by the UI — do NOT include image URLs or markdown images in your response.",
    inputSchema: zodSchema(TakeScreenshotInputSchema),
    execute: async (input, options) => {
      const startTime = performance.now();
      try {
        const token = process.env.BROWSERLESS_TOKEN;
        if (!token) {
          return {
            success: false as const,
            error: "BROWSERLESS_TOKEN is not configured.",
          };
        }

        // Use JPEG with quality to keep payload small for the LLM.
        // Set a viewport so the screenshot dimensions are predictable.
        const response = await fetch(
          `${BROWSERLESS_BASE_URL}/screenshot?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: input.url,
              options: {
                fullPage: input.fullPage ?? false,
                type: "jpeg",
                quality: JPEG_QUALITY,
              },
              viewport: DEFAULT_VIEWPORT,
            }),
          },
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          return {
            success: false as const,
            error: `Browserless screenshot failed (${response.status}): ${errorText}`,
            url: input.url,
          };
        }

        const imgBytes = new Uint8Array(await response.arrayBuffer());
        const mediaType = "image/jpeg";
        const key = `screenshots/${crypto.randomUUID()}.jpg`;

        // Upload to object storage — needed for UI rendering.
        // Also generates a presigned URL or data URI for injecting
        // the image into the conversation via prepareStep.
        let uri = `data:${mediaType};base64,${Buffer.from(imgBytes).toString("base64")}`;
        let imageUrl: string | null = null;

        if (ctx.objectStorage) {
          try {
            await ctx.objectStorage.put(key, imgBytes, {
              contentType: mediaType,
            });
            uri = toMeshStorageUri(key);
            imageUrl = await generatePresignedGetUrl(key, ctx);
          } catch (err) {
            console.error(
              "[take-screenshot] Failed to upload, using data: URI fallback",
              err,
            );
          }
        }

        // Fallback: use the data URI directly if no presigned URL
        if (!imageUrl) {
          imageUrl = `data:${mediaType};base64,${Buffer.from(imgBytes).toString("base64")}`;
        }

        // Queue the image for injection as a user message in prepareStep.
        // This bypasses provider limitations with images in tool results.
        pendingImages.push({
          url: imageUrl,
          mediaType,
          pageUrl: input.url,
        });

        toolOutputMap.set(
          options.toolCallId,
          `Screenshot of ${input.url} stored at ${uri}`,
        );

        return {
          success: true as const,
          image: { uri, mediaType },
          url: input.url,
        };
      } finally {
        const latencyMs = performance.now() - startTime;
        writer.write({
          type: "data-tool-metadata",
          id: options.toolCallId,
          data: { latencyMs },
        });
      }
    },
    // Return text-only result for the tool message. The actual image
    // is injected as a user message by prepareStep in stream-core.ts,
    // which is universally supported by all providers (including OpenRouter).
    toModelOutput({ output }) {
      if (!output.success) {
        return {
          type: "text",
          value: output.error ?? "Screenshot failed",
        };
      }
      return {
        type: "text",
        value: `Screenshot of ${output.url} captured successfully. The image is attached below.`,
      };
    },
  });
}
