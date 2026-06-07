/**
 * Cluster-side MCP exposure of the `generate_image` decopilot built-in.
 *
 * Runs image generation cluster-side (where the image-provider secret lives)
 * and returns stable mesh-storage:// URIs for the result. The desktop daemon
 * never holds the image-provider key; it only receives the URIs.
 *
 * Adaptation from in-process built-in:
 * - `provider` and `imageModelInfo` are re-activated from `credentialId` +
 *   `imageModelId` via `ctx.aiProviders.activate()` (the built-in receives
 *   pre-activated objects; the MCP tool only has the IDs in the input).
 * - `writer` (UIMessageStreamWriter for data-tool-metadata) is removed — the
 *   MCP tool returns results directly; no in-process stream to push to.
 * - Reference-image byte fetching is preserved: mesh-storage:// URIs, our own
 *   /api/:org/files/ URLs, data: URIs, and external HTTPS URLs are all supported.
 * - Object storage is required (no inline base64 fallback) — same as the built-in
 *   which throws when object storage is unavailable.
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { generateImage } from "ai";
import {
  toMeshStorageUri,
  parseMeshStorageKey,
} from "@/api/routes/decopilot/mesh-storage-uri";
import { getSettings } from "@/settings";

const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

function assertReferenceImageSize(bytes: number): void {
  if (bytes > MAX_REFERENCE_IMAGE_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const maxMb = MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024);
    throw new Error(
      `Reference image too large: ${mb} MB (max ${maxMb} MB). Use a smaller image.`,
    );
  }
}

const PRIVATE_HOST_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  /^\[fd/,
  /^\[fe80:/,
  /^\[::ffff:/i,
  /^localhost$/i,
];

function validateExternalUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid image URL");
  }
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

/** Pattern to extract the storage key from our own files endpoint URL. */
const FILES_URL_PATTERN = /\/api\/[^/]+\/files\/([^?#]+)/;

const GenerateImageMcpInputSchema = z.object({
  prompt: z
    .string()
    .max(10_000)
    .describe(
      "Detailed description of the image to generate. Be specific about style, composition, colors, and subject matter.",
    ),
  credentialId: z
    .string()
    .describe("Image-tier provider credential ID — resolved cluster-side."),
  imageModelId: z.string().describe("Image model ID to use for generation."),
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
      "Reference images to use as input for image-to-image generation.",
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

export const GENERATE_IMAGE_MCP = defineTool({
  name: "GENERATE_IMAGE_MCP" as const,
  description:
    "Generate an image from a text description, optionally using reference images. " +
    "Runs image generation cluster-side and returns stable mesh-storage:// URIs. " +
    "The image-provider key stays cluster-side; only the URIs are returned.",
  inputSchema: GenerateImageMcpInputSchema,
  outputSchema: z.object({
    success: z.literal(true),
    images: z.array(z.object({ uri: z.string(), mediaType: z.string() })),
    prompt: z.string(),
    model: z.string(),
    usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();

    const organization = ctx.organization;
    if (!organization) throw new Error("Organization context required");

    if (!ctx.objectStorage) {
      throw new Error(
        "Object storage is unavailable; cannot persist the generated image.",
      );
    }
    const objectStorage = ctx.objectStorage;

    // Re-activate provider from credential ID cluster-side.
    const provider = await ctx.aiProviders.activate(
      input.credentialId,
      organization.id,
    );

    const imageModel = provider.aiSdk.imageModel(input.imageModelId);

    // Fetch reference image bytes (same logic as the built-in).
    const hasRefs = input.referenceImages && input.referenceImages.length > 0;
    let refImageBytes: Uint8Array[] = [];

    if (hasRefs) {
      refImageBytes = await Promise.all(
        input.referenceImages!.map(async (ref) => {
          const raw = ref.uri ?? (ref as unknown as { url?: string }).url;
          if (!raw) throw new Error("Reference image missing uri");

          // mesh-storage://{key} — read directly from object storage
          const meshKey = parseMeshStorageKey(raw);
          if (meshKey !== null) {
            const { size } = await objectStorage.head(meshKey);
            assertReferenceImageSize(size);
            return objectStorage.getBytes(meshKey);
          }

          // Our own /api/:org/files/:key URL
          const filesMatch = raw.match(FILES_URL_PATTERN);
          if (filesMatch) {
            const { size } = await objectStorage.head(filesMatch[1]!);
            assertReferenceImageSize(size);
            return objectStorage.getBytes(filesMatch[1]!);
          }

          // data: URI — decode inline
          if (raw.startsWith("data:")) {
            const match = raw.match(/^data:[^;]+;base64,(.+)$/s);
            if (!match) throw new Error("Invalid data: URI");
            const bytes = Buffer.from(match[1]!, "base64");
            assertReferenceImageSize(bytes.byteLength);
            return bytes as unknown as Uint8Array;
          }

          // External HTTPS URL
          validateExternalUrl(raw);
          const res = await fetch(raw);
          if (!res.ok) {
            throw new Error(`Failed to fetch image from ${raw}: ${res.status}`);
          }
          const bytes = new Uint8Array(await res.arrayBuffer());
          assertReferenceImageSize(bytes.byteLength);
          return bytes;
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

    const images = await Promise.all(
      result.images.map(async (img) => {
        const mediaType = img.mediaType ?? "image/png";
        const ext = mediaType.split("/")[1] ?? "png";
        const key = `generated-images/${crypto.randomUUID()}.${ext}`;
        const bytes = Uint8Array.from(atob(img.base64), (c) => c.charCodeAt(0));
        await objectStorage.put(key, bytes, { contentType: mediaType });
        return { uri: toMeshStorageUri(key), mediaType };
      }),
    );

    return {
      success: true as const,
      images,
      prompt: input.prompt,
      model: input.imageModelId,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
    };
  },
});
