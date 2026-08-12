import { generateImage, tool, type UIMessageStreamWriter } from "ai";
import { zodSchema } from "ai";
import { lookup } from "node:dns/promises";
import { z } from "zod";
import {
  parseStudioStorageKey,
  toStudioStorageUri,
} from "../studio-storage-uri";
import type { PendingImage } from "./vm-tools/types";
import { BROWSERLESS_BASE_URL } from "./constants";

const FILES_URL_PATTERN = /\/api\/[^/]+\/files\/([^?#]+)/;
const MAX_REFERENCE_IMAGE_BYTES = 20 * 1024 * 1024;
const JPEG_QUALITY = 80;

/** Headroom over Browserless's own 30s page.goto timeout, so an unresponsive Browserless can't hang the harness run forever. */
const BROWSERLESS_SCREENSHOT_TIMEOUT_MS = 45_000;

/**
 * Emulation presets for `take_screenshot`. `mobile` carries a phone viewport
 * AND `isMobile`/`hasTouch` — but the load-bearing part for QA is that the tool
 * also sends `MOBILE_USER_AGENT` with it. Many sites pick their layout from the
 * request user-agent server-side (not just CSS breakpoints), so a desktop
 * browser merely narrowed to 390px still gets desktop markup — a plausible but
 * WRONG "mobile" shot. Emulating the device means the UA too; see
 * `captureScreenshot` for how it is sent.
 */
const DEVICE_VIEWPORTS = {
  desktop: {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  mobile: {
    width: 390,
    height: 844,
    // 2, not a phone's real 3: `clip` is in CSS px but the JPEG comes back in
    // DEVICE px, so the scale factor multiplies the height that has to fit
    // under MAX_SCREENSHOT_HEIGHT. At 3 a clamped full-page capture kept only
    // the first 2333 CSS px; 2 keeps 3500 and is still legible.
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
} as const;

export type ScreenshotDevice = keyof typeof DEVICE_VIEWPORTS;

const DEFAULT_VIEWPORT = DEVICE_VIEWPORTS.desktop;

/** Sent as the request user-agent when `device: "mobile"`, so server-side
 *  user-agent sniffing returns the real mobile markup. A current iOS Safari. */
const MOBILE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
/**
 * Anthropic rejects any image over 8000px on either side, and an oversized
 * screenshot poisons the thread permanently: it is inlined as base64 into the
 * message history, so every later turn replays it and gets the same 400. A
 * full-page capture of a long landing page blows past this easily.
 */
const MAX_SCREENSHOT_HEIGHT = 7000;

/**
 * Puppeteer rejects `clip` together with `fullPage` — they are exclusive.
 *
 * `clip` is CSS pixels; the returned JPEG is CSS px × `deviceScaleFactor`. The
 * ceiling being enforced is on the IMAGE, so the clip height is divided by the
 * device's scale factor — clamping to a flat 7000 on a 2×/3× device produced a
 * 14000/21000px image, i.e. the clamped retry could never come back under the
 * limit and every full-page mobile capture failed.
 */
export function buildScreenshotOptions(
  fullPage: boolean,
  clamped = false,
  viewport: { width: number; deviceScaleFactor: number } = DEFAULT_VIEWPORT,
) {
  return {
    ...(fullPage && clamped
      ? {
          clip: {
            x: 0,
            y: 0,
            width: viewport.width,
            height: Math.floor(
              MAX_SCREENSHOT_HEIGHT / viewport.deviceScaleFactor,
            ),
          },
        }
      : { fullPage }),
    type: "jpeg" as const,
    quality: JPEG_QUALITY,
  };
}

/**
 * The Browserless `/screenshot` request body.
 *
 * Split out and pure so the wire shape is assertable: a mobile capture carries
 * its user-agent as a request HEADER, not in Browserless's own `userAgent`
 * field, because that field's shape is version-specific and the two forms are
 * mutually exclusive — v1 accepts a string and 400s on an object, v2 accepts an
 * object and 400s on a string, while `setExtraHTTPHeaders` is accepted AND
 * honored by both (verified against browserless/chrome and
 * browserless/chromium). Sending the wrong one fails EVERY mobile capture with
 * a 400, which is invisible until someone asks for a mobile screenshot.
 *
 * A header does not change `navigator.userAgent`, so client-side sniffing still
 * sees Chrome — for that part, `isMobile`/`hasTouch` in the viewport is what
 * carries.
 */
export function buildScreenshotRequestBody(
  url: string,
  device: ScreenshotDevice,
  fullPage: boolean,
  clamped: boolean,
) {
  const viewport = DEVICE_VIEWPORTS[device];
  return {
    url,
    options: buildScreenshotOptions(fullPage, clamped, viewport),
    viewport,
    ...(viewport.isMobile
      ? { setExtraHTTPHeaders: { "User-Agent": MOBILE_USER_AGENT } }
      : {}),
  };
}

/**
 * Capture one page as a JPEG via Browserless, clamped to a height the model
 * providers accept.
 *
 * Used by the Decopilot `take_screenshot` built-in. The sandbox-hosted harness
 * does NOT come through here — it has a real browser in its image and runs
 * `qa-screenshot` (packages/sandbox/image/bin/qa-screenshot), which keeps the
 * same viewport presets and height ceiling so a before/after pair captured on
 * the two paths is still comparable.
 */
async function captureScreenshot(params: {
  url: string;
  token: string;
  device?: ScreenshotDevice;
  fullPage?: boolean;
}): Promise<
  | { ok: true; bytes: Uint8Array; mediaType: "image/jpeg" }
  | { ok: false; error: string }
> {
  const { url, token } = params;
  const fullPage = params.fullPage ?? false;
  const device = params.device ?? "desktop";

  const shoot = async (clamped: boolean) =>
    await fetch(
      `${BROWSERLESS_BASE_URL}/screenshot?token=${encodeURIComponent(token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildScreenshotRequestBody(url, device, fullPage, clamped),
        ),
        signal: AbortSignal.timeout(BROWSERLESS_SCREENSHOT_TIMEOUT_MS),
      },
    );

  let response: Response;
  try {
    response = await shoot(false);
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      ok: false,
      error: isTimeout
        ? `Browserless screenshot of ${url} timed out after ${BROWSERLESS_SCREENSHOT_TIMEOUT_MS}ms`
        : `Browserless screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    return {
      ok: false,
      error: `Browserless screenshot failed (${response.status}): ${errorText}`,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const height = jpegHeight(bytes);
  if (!fullPage || height === null || height <= MAX_SCREENSHOT_HEIGHT) {
    return { ok: true, bytes, mediaType: "image/jpeg" };
  }

  const retry = await shoot(true).catch(() => null);
  const clipped = retry?.ok ? new Uint8Array(await retry.arrayBuffer()) : null;
  // Emitting an oversized capture would brick the thread, so fail the call
  // instead — the caller can retry without `fullPage`.
  if (!clipped || (jpegHeight(clipped) ?? 0) > MAX_SCREENSHOT_HEIGHT) {
    return {
      ok: false,
      error: `Full-page screenshot of ${url} is ${height}px tall, over the ${MAX_SCREENSHOT_HEIGHT}px limit, and the clipped retry did not come back within it. Retry with fullPage: false.`,
    };
  }
  return { ok: true, bytes: clipped, mediaType: "image/jpeg" };
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
  device: z
    .enum(["desktop", "mobile"])
    .optional()
    .describe(
      "Device to emulate. `mobile` uses a phone viewport (390×844) AND a mobile " +
        "user-agent, so sites that switch layout by user-agent — not just CSS " +
        "breakpoints — return their real mobile markup. To document a responsive " +
        "change, capture both `desktop` and `mobile`. Defaults to `desktop`.",
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
  await assertUrlDoesNotResolvePrivate(url);
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
      'Pass `device: "mobile"` to capture the true mobile layout (phone viewport ' +
      "+ mobile user-agent), and capture both `desktop` and `mobile` to document " +
      "a responsive change. " +
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
        const device: ScreenshotDevice = input.device ?? "desktop";
        const captured = await captureScreenshot({
          url: input.url,
          token,
          device,
          fullPage: input.fullPage ?? false,
        });
        if (!captured.ok) {
          return {
            success: false as const,
            error: captured.error,
            url: input.url,
          };
        }
        let imgBytes = captured.bytes;
        const mediaType = captured.mediaType;
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
          `Screenshot (${device}) of ${input.url} stored at ${uri}`,
        );

        return {
          success: true as const,
          image: { uri, mediaType },
          url: input.url,
          device,
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
        value: `Screenshot of ${output.url} (${output.device ?? "desktop"}) captured successfully. The image is attached below.`,
      };
    },
  });
}
