import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import { getSettings } from "@/settings";
import { requireObjectStorage } from "../object-storage/schema";
import {
  captureScreenshot,
  TakeScreenshotInputSchema,
} from "@/harnesses/lib/decopilot/built-in-tools/portable-media-tools";

/** Long enough for a reviewer to fetch the image and to still resolve for a
 *  human opening the task comment that links it, hours later. */
const PRESIGN_EXPIRES_IN = 24 * 60 * 60;

/**
 * Screenshot a page from Studio, for a harness that has no browser of its own.
 *
 * The Decopilot built-in `take_screenshot` exists only inside the hosted loop;
 * the sandbox-hosted claude-code harness (which is what a task-board reviewer
 * runs on) has no built-ins and no browser in its image. Rather than bake
 * Chromium into a sandbox image — ~750MB on every pod, plus a second
 * SandboxTemplate and warm pool to route QA runs onto — the capture happens
 * here, where the Browserless credential already lives and never has to enter a
 * sandbox.
 *
 * Returns a presigned URL, not the bytes: the caller is an agent over MCP that
 * wants to link the image in a comment (and can `curl` it if it wants to look).
 */
export const TAKE_SCREENSHOT = defineTool({
  name: "TAKE_SCREENSHOT",
  description:
    "Screenshot a web page and store it, returning a link to the image. " +
    "Use this to verify a deployment or preview renders, to check a page's " +
    'layout, or to document a visual change. Pass `device: "mobile"` for the ' +
    "true mobile layout (phone viewport + mobile user-agent, so sites that " +
    "switch layout by user-agent return their real mobile markup); capture " +
    "both `desktop` and `mobile` to document a responsive change. The returned " +
    "`url` can be linked in a comment, or downloaded (`curl -o shot.jpg <url>`) " +
    "and opened if you need to look at it yourself.",
  annotations: {
    title: "Take Screenshot",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: TakeScreenshotInputSchema,
  outputSchema: z.object({
    url: z.string().describe("Presigned URL of the stored screenshot."),
    key: z.string().describe("Object storage key of the stored screenshot."),
    device: z.enum(["desktop", "mobile"]),
    expiresIn: z
      .number()
      .describe("Seconds until the presigned URL stops resolving."),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    requireOrganization(ctx);
    await ctx.access.check();
    const storage = requireObjectStorage(ctx);

    const token = getSettings().browserlessToken;
    if (!token) throw new Error("BROWSERLESS_TOKEN is not configured.");

    const device = input.device ?? "desktop";
    const captured = await captureScreenshot({
      url: input.url,
      token,
      device,
      fullPage: input.fullPage ?? false,
    });
    if (!captured.ok) throw new Error(captured.error);

    const key = `screenshots/${crypto.randomUUID()}.jpg`;
    await storage.put(key, captured.bytes, { contentType: captured.mediaType });

    return {
      url: await storage.presignedGetUrl(key, PRESIGN_EXPIRES_IN),
      key,
      device,
      expiresIn: PRESIGN_EXPIRES_IN,
    };
  },
});
