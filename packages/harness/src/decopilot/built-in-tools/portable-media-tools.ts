import { generateImage, tool, type UIMessageStreamWriter } from "ai";
import { zodSchema } from "ai";
import { z } from "zod";
import {
  parseStudioStorageKey,
  toStudioStorageUri,
} from "../studio-storage-uri";
import type { PendingImage } from "./vm-tools/types";
import { BROWSERLESS_BASE_URL } from "./constants";

const FILES_URL_PATTERN = /\/api\/[^/]+\/files\/([^?#]+)/;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = 80;
/**
 * Anthropic rejects any image over 8000px on either side, and an oversized
 * screenshot poisons the thread permanently: it is inlined as base64 into the
 * message history, so every later turn replays it and gets the same 400. A
 * full-page capture of a long landing page blows past this easily.
 */
const MAX_SCREENSHOT_HEIGHT = 7000;

/** Puppeteer rejects `clip` together with `fullPage` — they are exclusive. */
export function buildScreenshotOptions(fullPage: boolean, clamped = false) {
  return {
    ...(fullPage && clamped
      ? {
          clip: {
            x: 0,
            y: 0,
            width: DEFAULT_VIEWPORT.width,
            height: MAX_SCREENSHOT_HEIGHT,
          },
        }
      : { fullPage }),
    type: "jpeg" as const,
    quality: JPEG_QUALITY,
  };
}

/**
 * Height of a JPEG, read off its SOF marker. Returns null if the bytes aren't
 * a JPEG we can parse — callers treat that as "assume it's fine".
 */
export function jpegHeight(bytes: Uint8Array): number | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1] as number;
    // SOF0-SOF15 carry the frame dimensions; C4/C8/CC are other segments.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      ![0xc4, 0xc8, 0xcc].includes(marker)
    )
      return view.getUint16(i + 5);
    i += 2 + view.getUint16(i + 2);
  }
  return null;
}

export interface PortableMediaObjectStorage {
  put(
    key: string,
    body: string | Uint8Array,
    options?: { contentType?: string },
  ): Promise<unknown>;
  head?(key: string): Promise<{ size: number }>;
  getBytes?(key: string): Promise<Uint8Array>;
  presignedGetUrl?(key: string, expiresIn?: number): Promise<string>;
}

export interface PortableImageProvider {
  aiSdk: {
    imageModel: (
      modelId: string,
    ) => Parameters<typeof generateImage>[0]["model"];
  };
}

export interface PortableImageModelInfo {
  id: string;
}

export const GenerateImageInputSchema = z.object({
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
            "URI of the reference image (e.g. studio-storage://generated-images/uuid.png).",
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

function assertReferenceImageSize(bytes: number): void {
  if (bytes > MAX_REFERENCE_IMAGE_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    const maxMb = MAX_REFERENCE_IMAGE_BYTES / (1024 * 1024);
    throw new Error(
      `Reference image too large: ${mb} MB (max ${maxMb} MB). Use a smaller image.`,
    );
  }
}

function validateExternalUrl(url: string, allowHttp: boolean): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid image URL");
  }

  if (
    parsed.protocol !== "https:" &&
    !(allowHttp && parsed.protocol === "http:")
  ) {
    throw new Error("Image URL must use HTTPS");
  }

  for (const pattern of PRIVATE_HOST_PATTERNS) {
    if (pattern.test(parsed.hostname)) {
      throw new Error("Image URL must not point to a private network address");
    }
  }
}

async function readFromObjectStorage(
  key: string,
  objectStorage: PortableMediaObjectStorage | null | undefined,
): Promise<Uint8Array> {
  if (!objectStorage?.getBytes) {
    throw new Error("Object storage read is not available");
  }
  if (objectStorage.head) {
    const { size } = await objectStorage.head(key);
    assertReferenceImageSize(size);
  }
  const bytes = await objectStorage.getBytes(key);
  assertReferenceImageSize(bytes.byteLength);
  return bytes;
}

async function fetchImageBytes(
  url: string,
  params: {
    objectStorage?: PortableMediaObjectStorage | null;
    allowHttpExternalUrls?: boolean;
    abortSignal?: AbortSignal;
  },
): Promise<Uint8Array> {
  const storageKey = parseStudioStorageKey(url);
  if (storageKey !== null) {
    return readFromObjectStorage(storageKey, params.objectStorage);
  }

  const filesMatch = url.match(FILES_URL_PATTERN);
  if (filesMatch) {
    return readFromObjectStorage(filesMatch[1]!, params.objectStorage);
  }

  if (url.startsWith("data:")) {
    const match = url.match(/^data:[^;]+;base64,(.+)$/s);
    if (!match) throw new Error("Invalid data: URI");
    const bytes = Buffer.from(match[1]!, "base64");
    assertReferenceImageSize(bytes.byteLength);
    return bytes;
  }

  validateExternalUrl(url, params.allowHttpExternalUrls === true);
  const res = await fetch(url, { signal: params.abortSignal });
  if (!res.ok) {
    throw new Error(`Failed to fetch image from ${url}: ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  assertReferenceImageSize(bytes.byteLength);
  return bytes;
}

export interface GenerateImageCoreParams {
  provider: PortableImageProvider;
  imageModelInfo: PortableImageModelInfo;
  objectStorage?: PortableMediaObjectStorage | null;
  allowHttpExternalUrls?: boolean;
  /** Aborts the in-flight provider call (and reference-image fetches). Wired by
   *  the cluster's background job to the NATS-broadcast thread-cancel path so a
   *  cancelled turn stops generation mid-flight, not just at the next step. */
  abortSignal?: AbortSignal;
}

export interface GenerateImageResult {
  success: true;
  images: Array<{ uri: string; mediaType: string }>;
  prompt: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  usedReferenceImages: number;
}

/**
 * The heavy image-generation body, extracted so it can run either inline
 * inside the tool's `execute` (desktop / no background dispatcher) or from a
 * durable background job on any pod (cluster). Pure over its inputs +
 * injected `provider`/`objectStorage`, so a DBOS step can re-run it
 * deterministically — no `writer`, no `toolCallId`, no UI side effects.
 */
export async function generateImageCore(
  input: GenerateImageInput,
  params: GenerateImageCoreParams,
): Promise<GenerateImageResult> {
  const { provider, imageModelInfo, objectStorage } = params;
  const imageModel = provider.aiSdk.imageModel(imageModelInfo.id);
  const hasRefs = input.referenceImages && input.referenceImages.length > 0;
  const refImageBytes = hasRefs
    ? await Promise.all(
        input.referenceImages!.map((ref) => {
          const raw = ref.uri ?? (ref as unknown as { url?: string }).url;
          if (!raw) throw new Error("Reference image missing uri");
          return fetchImageBytes(raw, params);
        }),
      )
    : [];
  const prompt = hasRefs
    ? { text: input.prompt, images: refImageBytes }
    : input.prompt;
  const result = await generateImage({
    model: imageModel,
    prompt,
    n: input.n ?? 1,
    ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
  });

  if (!objectStorage) {
    throw new Error(
      "Object storage is unavailable; cannot persist the generated image.",
    );
  }

  // Thinking image models (e.g. Gemini 3 Pro Image) emit intermediate
  // draft images alongside the final one in a single response. Keep only
  // the last N — the final renders — so we don't surface duplicate drafts.
  const requested = input.n ?? 1;
  const finalImages =
    result.images.length > requested
      ? result.images.slice(-requested)
      : result.images;

  const images = await Promise.all(
    finalImages.map(async (img) => {
      const mediaType = img.mediaType ?? "image/png";
      const ext = mediaType.split("/")[1] ?? "png";
      const key = `generated-images/${crypto.randomUUID()}.${ext}`;
      const bytes = Uint8Array.from(atob(img.base64), (c) => c.charCodeAt(0));
      await objectStorage.put(key, bytes, { contentType: mediaType });
      return { uri: toStudioStorageUri(key), mediaType };
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
}

export function createPortableGenerateImageTool(
  writer: UIMessageStreamWriter,
  params: GenerateImageCoreParams,
) {
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
        return await generateImageCore(input, params);
      } finally {
        writer.write({
          type: "data-tool-metadata",
          id: options.toolCallId,
          data: { latencyMs: performance.now() - startTime },
        });
      }
    },
  });
}

export function createPortableTakeScreenshotTool(
  writer: UIMessageStreamWriter,
  params: {
    objectStorage?: PortableMediaObjectStorage | null;
    toolOutputMap: Map<string, string>;
    pendingImages: PendingImage[];
    browserlessToken?: string;
  },
) {
  const { objectStorage, toolOutputMap, pendingImages } = params;

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
        const token = params.browserlessToken ?? process.env.BROWSERLESS_TOKEN;
        if (!token) {
          return {
            success: false as const,
            error: "BROWSERLESS_TOKEN is not configured.",
          };
        }
        const fullPage = input.fullPage ?? false;
        const shoot = async (clamped: boolean) =>
          await fetch(
            `${BROWSERLESS_BASE_URL}/screenshot?token=${encodeURIComponent(token)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                url: input.url,
                options: buildScreenshotOptions(fullPage, clamped),
                viewport: DEFAULT_VIEWPORT,
              }),
            },
          );

        let response = await shoot(false);
        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          return {
            success: false as const,
            error: `Browserless screenshot failed (${response.status}): ${errorText}`,
            url: input.url,
          };
        }

        let imgBytes = new Uint8Array(await response.arrayBuffer());
        const height = jpegHeight(imgBytes);
        if (fullPage && height !== null && height > MAX_SCREENSHOT_HEIGHT) {
          response = await shoot(true);
          const clipped = response.ok
            ? new Uint8Array(await response.arrayBuffer())
            : null;
          // Emitting an oversized capture would brick the thread, so fail the
          // tool call instead — the model can retry without `fullPage`.
          if (!clipped || (jpegHeight(clipped) ?? 0) > MAX_SCREENSHOT_HEIGHT) {
            return {
              success: false as const,
              error: `Full-page screenshot of ${input.url} is ${height}px tall, over the ${MAX_SCREENSHOT_HEIGHT}px limit, and the clipped retry did not come back within it. Retry with fullPage: false.`,
              url: input.url,
            };
          }
          imgBytes = clipped;
        }
        const mediaType = "image/jpeg";
        const key = `screenshots/${crypto.randomUUID()}.jpg`;
        let uri: string;
        let imageUrl: string | null = null;

        if (objectStorage) {
          try {
            await objectStorage.put(key, imgBytes, { contentType: mediaType });
            uri = toStudioStorageUri(key);
            imageUrl =
              (await objectStorage.presignedGetUrl?.(key, 600)) ?? null;
          } catch (err) {
            console.error(
              "[take-screenshot] Failed to upload, using data: URI fallback",
              err,
            );
            uri = `data:${mediaType};base64,${Buffer.from(imgBytes).toString("base64")}`;
          }
        } else {
          uri = `data:${mediaType};base64,${Buffer.from(imgBytes).toString("base64")}`;
        }

        if (!imageUrl) {
          imageUrl = uri.startsWith("data:")
            ? uri
            : `data:${mediaType};base64,${Buffer.from(imgBytes).toString("base64")}`;
        }

        pendingImages.push({ url: imageUrl, mediaType, pageUrl: input.url });
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
        writer.write({
          type: "data-tool-metadata",
          id: options.toolCallId,
          data: { latencyMs: performance.now() - startTime },
        });
      }
    },
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
