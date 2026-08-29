import { generateImage, tool, type UIMessageStreamWriter } from "ai";
import { zodSchema } from "ai";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import {
  parseStudioStorageKey,
  toStudioStorageUri,
} from "../studio-storage-uri";

const FILES_URL_PATTERN = /\/api\/[^/]+\/files\/([^?#]+)/;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;

/** Without this, an unresponsive reference-image host hangs the fetch (and the
 *  whole harness run) forever — `params.abortSignal` only covers user-initiated
 *  cancellation, not a stalled remote server. */
const REFERENCE_IMAGE_FETCH_TIMEOUT_MS = 45_000;

/** Same reasoning as REFERENCE_IMAGE_FETCH_TIMEOUT_MS above: `params.abortSignal`
 *  only fires on user/run cancellation, so an unresponsive image-model provider
 *  would otherwise hang the harness run forever. Longer than the other timeouts
 *  in this file because image generation is genuinely slower than a plain fetch. */
const GENERATE_IMAGE_TIMEOUT_MS = 120_000;

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
    // Each entry fans out into its own outbound fetch in generateImageCore.
    .max(10)
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

const PRIVATE_HOST_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^\[::1\]$/,
  // RFC 4193 unique local addresses are fc00::/7 — first byte fc OR fd.
  /^\[f[cd]/,
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

export function validateExternalUrl(url: string, allowHttp: boolean): void {
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

/** Bare resolved IP (no brackets) against the same private/loopback/link-local
 *  ranges `PRIVATE_HOST_PATTERNS` vets on the literal hostname. */
function isPrivateIpAddress(ip: string): boolean {
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  const v6 = ip.toLowerCase();
  return (
    v6 === "::1" ||
    v6.startsWith("::ffff:") ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe80")
  );
}

/**
 * DNS-rebinding guard: `validateExternalUrl` only vets the literal hostname
 * written in the URL, so a domain whose DNS record points at a private or
 * cloud-metadata address (an attacker-controlled A record) sails right
 * through it and reaches an internal service through this tool's own
 * `fetch`. `resolveHost` is injectable for tests; production resolves real DNS.
 */
export async function assertUrlDoesNotResolvePrivate(
  url: string,
  resolveHost: (host: string) => Promise<string[]> = async (host) =>
    (await lookup(host, { all: true })).map((r) => r.address),
): Promise<void> {
  const hostname = new URL(url).hostname;
  const isIpLiteral =
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname) ||
    (hostname.startsWith("[") && hostname.endsWith("]"));
  // An IP literal is already fully vetted synchronously by validateExternalUrl.
  if (isIpLiteral) return;
  let addresses: string[];
  try {
    addresses = await resolveHost(hostname);
  } catch {
    // Can't verify where this hostname actually points — fail closed.
    throw new Error("Image URL must not point to a private network address");
  }
  if (addresses.length === 0 || addresses.some(isPrivateIpAddress)) {
    throw new Error("Image URL must not point to a private network address");
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

export async function fetchImageBytes(
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
  await assertUrlDoesNotResolvePrivate(url);
  const timeoutSignal = AbortSignal.timeout(REFERENCE_IMAGE_FETCH_TIMEOUT_MS);
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, timeoutSignal])
    : timeoutSignal;
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        `Fetching image from ${url} timed out after ${REFERENCE_IMAGE_FETCH_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }
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
  const timeoutSignal = AbortSignal.timeout(GENERATE_IMAGE_TIMEOUT_MS);
  const signal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, timeoutSignal])
    : timeoutSignal;
  let result: Awaited<ReturnType<typeof generateImage>>;
  try {
    result = await generateImage({
      model: imageModel,
      prompt,
      n: input.n ?? 1,
      ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
      abortSignal: signal,
    });
  } catch (err) {
    if (timeoutSignal.aborted && !params.abortSignal?.aborted) {
      throw new Error(
        `Image generation timed out after ${GENERATE_IMAGE_TIMEOUT_MS}ms`,
      );
    }
    throw err;
  }

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
