/**
 * Cluster-side MCP exposure of the `take_screenshot` decopilot built-in.
 *
 * Captures a JPEG via Browserless, uploads to object storage (cluster-only),
 * and returns a presigned GET URL valid for 10 minutes so the desktop daemon
 * can embed the result in the conversation without holding object-storage credentials.
 * Object storage credentials never leave the cluster.
 *
 * Adaptation from in-process built-in:
 * - `pendingImages` (in-process buffer for image injection via prepareStep) is removed.
 *   The MCP tool returns the presigned URL directly; the desktop harness handles rendering.
 * - `toolOutputMap` (in-process map keyed by toolCallId) is removed.
 *   The MCP tool returns the meshStorageUri directly in the result.
 * - `writer` (UIMessageStreamWriter for data-tool-metadata) is removed — the MCP
 *   tool completes synchronously and latency is not emitted separately.
 * - Falls back to a data: URI when object storage is unavailable (mirrors built-in behavior).
 */
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { toMeshStorageUri } from "@/api/routes/decopilot/mesh-storage-uri";
import { generatePresignedGetUrl } from "@/api/routes/decopilot/file-materializer";
import { BROWSERLESS_BASE_URL } from "@/harnesses/decopilot/built-in-tools/constants";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
const JPEG_QUALITY = 80;

const TakeScreenshotMcpInputSchema = z.object({
  url: z.string().url().describe("The URL of the web page to screenshot."),
  fullPage: z
    .boolean()
    .optional()
    .describe(
      "When true, captures the full scrollable page instead of just the viewport. Defaults to false.",
    ),
});

export const TAKE_SCREENSHOT_MCP = defineTool({
  name: "TAKE_SCREENSHOT_MCP" as const,
  description:
    "Capture a screenshot of a web page using Browserless. Returns a time-limited " +
    "presigned URL to the JPEG and the stable mesh-storage:// URI so it can be " +
    "displayed in the conversation. Object storage credentials stay cluster-side.",
  inputSchema: TakeScreenshotMcpInputSchema,
  outputSchema: z.union([
    z.object({
      success: z.literal(true),
      presignedUrl: z.string(),
      meshStorageUri: z.string(),
      mediaType: z.literal("image/jpeg"),
      pageUrl: z.string(),
    }),
    z.object({
      success: z.literal(false),
      error: z.string(),
      pageUrl: z.string().optional(),
    }),
  ]),
  handler: async (input, ctx) => {
    await ctx.access.check();

    const token = process.env.BROWSERLESS_TOKEN;
    if (!token) {
      return {
        success: false as const,
        error: "BROWSERLESS_TOKEN is not configured on the cluster.",
        pageUrl: input.url,
      };
    }

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
        pageUrl: input.url,
      };
    }

    const imgBytes = new Uint8Array(await response.arrayBuffer());
    const mediaType = "image/jpeg" as const;
    const key = `screenshots/${crypto.randomUUID()}.jpg`;

    if (ctx.objectStorage) {
      try {
        await ctx.objectStorage.put(key, imgBytes, { contentType: mediaType });
        const meshStorageUri = toMeshStorageUri(key);
        // generatePresignedGetUrl returns string | null; fall through to data: URI on null.
        const presignedUrl = await generatePresignedGetUrl(key, ctx);
        if (presignedUrl !== null) {
          return {
            success: true as const,
            presignedUrl,
            meshStorageUri,
            mediaType,
            pageUrl: input.url,
          };
        }
        // presigned URL generation failed — return meshStorageUri as the URL reference
        return {
          success: true as const,
          presignedUrl: meshStorageUri,
          meshStorageUri,
          mediaType,
          pageUrl: input.url,
        };
      } catch (err) {
        console.error(
          "[take-screenshot-mcp] Failed to upload to object storage, using data: URI fallback",
          err,
        );
      }
    }

    // Fallback when object storage is unavailable: return inline data URI.
    const dataUri = `data:${mediaType};base64,${Buffer.from(imgBytes).toString("base64")}`;
    return {
      success: true as const,
      presignedUrl: dataUri,
      meshStorageUri: dataUri,
      mediaType,
      pageUrl: input.url,
    };
  },
});
