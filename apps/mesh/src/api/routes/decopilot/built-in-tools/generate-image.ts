/**
 * generate_image Built-in Tool
 *
 * Server-side tool that generates images using the selected image model.
 * Uses AI SDK generateImage() with the provider's imageModel().
 *
 * Generated images are uploaded to object storage and their stable URLs
 * are returned in the tool result. The model can pass these URLs back as
 * referenceImages in follow-up calls. The frontend reads the URLs from
 * the tool result to render the images.
 *
 * Supports reference images via URL: the AI passes image URLs from the
 * conversation (uploaded files, previously generated images) and the tool
 * fetches the bytes before calling the image model.
 */

import { tool, zodSchema, generateImage, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { MeshProvider } from "@/ai-providers/types";
import type { MeshContext } from "@/core/mesh-context";
import { getSettings } from "@/settings";
import type { ModelInfo } from "../types";
import { toMeshStorageUri, parseMeshStorageKey } from "../mesh-storage-uri";

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
        uri: z
          .string()
          .describe(
            "URI of the reference image (e.g. mesh-storage://generated-images/uuid.png).",
          ),
      }),
    )
    .optional()
    .describe(
      "Reference images to use as input for image-to-image generation. " +
        "Pass the URI of any image from the conversation (uploaded files, previously generated images, etc.) " +
        "when the user wants to modify, transform, or use an existing image as a starting point.",
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

/** Pattern to extract the storage key from our own files endpoint URL. */
const FILES_URL_PATTERN = /\/api\/[^/]+\/files\/([^?#]+)/;

/**
 * Resolve an image URL to raw bytes.
 * Handles mesh-storage: URIs, our own /api/:org/files/ URLs,
 * data: URIs, and external HTTP(S) URLs.
 */
async function fetchImageBytes(
  url: string,
  ctx: MeshContext,
): Promise<Uint8Array> {
  // mesh-storage://{key} — read directly from object storage
  const meshKey = parseMeshStorageKey(url);
  if (meshKey !== null) {
    return readFromObjectStorage(meshKey, ctx);
  }

  // Our own /api/:org/files/:key URL — extract key and read directly
  // instead of round-tripping through HTTP (which would lack auth cookies).
  const filesMatch = url.match(FILES_URL_PATTERN);
  if (filesMatch) {
    return readFromObjectStorage(filesMatch[1]!, ctx);
  }

  // data: URI — decode inline
  if (url.startsWith("data:")) {
    const match = url.match(/^data:[^;]+;base64,(.+)$/s);
    if (!match) throw new Error("Invalid data: URI");
    return Buffer.from(match[1]!, "base64");
  }

  // External HTTP(S) URL — validate before fetching to prevent SSRF
  validateExternalUrl(url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

const PRIVATE_HOST_PATTERNS = [
  /^127\./, // loopback
  /^10\./, // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./, // 192.168.0.0/16
  /^169\.254\./, // link-local (cloud metadata)
  /^0\./, // 0.0.0.0/8
  /^\[::1\]$/, // IPv6 loopback
  /^\[fd/, // IPv6 unique local
  /^\[fe80:/, // IPv6 link-local
  /^\[::ffff:/i, // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  /^localhost$/i,
];

function validateExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid image URL");
  }

  // Local mode is single-tenant developer experience and may want to point
  // at `http://localhost`-style fixtures; everywhere else requires HTTPS.
  const allowHttp = getSettings().localMode;
  if (
    parsed.protocol !== "https:" &&
    !(allowHttp && parsed.protocol === "http:")
  ) {
    throw new Error("Image URL must use HTTPS");
  }

  const host = parsed.hostname;
  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(host)) {
      throw new Error("Image URL must not point to a private network address");
    }
  }
}

async function readFromObjectStorage(
  key: string,
  ctx: MeshContext,
): Promise<Uint8Array> {
  if (!ctx.objectStorage) {
    throw new Error("Object storage not available");
  }
  const result = await ctx.objectStorage.get(key);
  if ("content" in result && typeof result.content === "string") {
    if (result.encoding === "base64") {
      return Buffer.from(result.content, "base64");
    }
    return new TextEncoder().encode(result.content);
  }
  throw new Error(`Failed to read from object storage: ${key}`);
}

export function createGenerateImageTool(
  writer: UIMessageStreamWriter,
  params: {
    provider: MeshProvider;
    imageModelInfo: ModelInfo;
    ctx: MeshContext;
  },
) {
  const { provider, imageModelInfo, ctx } = params;

  return tool({
    description:
      "Generate an image from a text description, optionally using reference images. " +
      "Use this when the user asks you to create, generate, draw, or design an image. " +
      "If the user has attached images and wants to modify or use them as a reference, " +
      "pass them as referenceImages. " +
      "The image is displayed automatically by the UI — do NOT include image URLs or markdown images in your response.",
    inputSchema: zodSchema(GenerateImageInputSchema),
    execute: async (input, options) => {
      const startTime = performance.now();
      try {
        const imageModel = provider.aiSdk.imageModel(imageModelInfo.id);

        // Build the prompt: text-only or text + reference images
        const hasRefs =
          input.referenceImages && input.referenceImages.length > 0;

        let refImageBytes: Uint8Array[] = [];
        if (hasRefs) {
          refImageBytes = await Promise.all(
            input.referenceImages!.map((ref) => {
              // Accept both `uri` (current schema) and `url` (legacy threads)
              const raw = ref.uri ?? (ref as unknown as { url?: string }).url;
              if (!raw) throw new Error("Reference image missing uri");
              return fetchImageBytes(raw, ctx);
            }),
          );
        }

        const prompt = hasRefs
          ? { text: input.prompt, images: refImageBytes }
          : input.prompt;

        const result = await generateImage({
          model: imageModel,
          prompt,
          n: input.n ?? 1,
          ...(input.aspectRatio && { aspectRatio: input.aspectRatio }),
        });

        // Upload images to object storage, return stable mesh-storage: URIs.
        // The model sees only URIs (lightweight, opaque); the frontend resolves
        // them to fetchable URLs for rendering.
        const images = await Promise.all(
          result.images.map(async (img) => {
            const mediaType = img.mediaType ?? "image/png";
            const ext = mediaType.split("/")[1] ?? "png";
            const key = `generated-images/${crypto.randomUUID()}.${ext}`;

            if (ctx.objectStorage) {
              try {
                const bytes = Uint8Array.from(atob(img.base64), (c) =>
                  c.charCodeAt(0),
                );
                await ctx.objectStorage.put(key, bytes, {
                  contentType: mediaType,
                });
                return { uri: toMeshStorageUri(key), mediaType };
              } catch (err) {
                console.error(
                  "[generate-image] Failed to upload, falling back to data: URI",
                  err,
                );
              }
            }
            // Fallback: inline data: URI (no object storage configured)
            return {
              uri: `data:${mediaType};base64,${img.base64}`,
              mediaType,
            };
          }),
        );

        return {
          success: true,
          images,
          prompt: input.prompt,
          model: imageModelInfo.id,
          usage: {
            inputTokens: result.usage.inputTokens ?? 0,
            outputTokens: result.usage.outputTokens ?? 0,
          },
          usedReferenceImages: hasRefs ? input.referenceImages!.length : 0,
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
  });
}
