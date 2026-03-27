/**
 * Screenshot Built-in Tool
 *
 * Takes a screenshot of a URL via Browserless (puppeteer-core).
 * Saves to dev-assets storage and returns a presigned URL.
 */

import { tool, zodSchema } from "ai";
import { z } from "zod";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  urlInput,
  deviceInput,
  MAX_TIMEOUT_MS,
  resolveBrowserEndpoint,
  withBrowserPage,
} from "./browserless";
import { getSettings } from "@/settings";

export const InputSchema = z.object({
  url: urlInput.describe("The URL to screenshot"),
  fullPage: z
    .boolean()
    .default(false)
    .describe("Capture the full scrollable page"),
  device: deviceInput,
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
    .default("networkidle2")
    .describe("When to consider navigation complete"),
  timeout: z
    .number()
    .max(MAX_TIMEOUT_MS)
    .default(30000)
    .describe("Navigation timeout in milliseconds"),
  cookies: z
    .record(z.string(), z.string())
    .optional()
    .describe(
      "Cookies to set on every request as key-value pairs, e.g. { '_deco_bucket': 'worker' }",
    ),
});

/** Max screenshot size: 5 MB */
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;

const DEV_ASSETS_BASE_DIR = "./data/assets";

/** Generate a presigned GET URL for a dev-assets file */
function generatePresignedUrl(
  orgId: string,
  key: string,
  baseUrl: string,
): string {
  const settings = getSettings();
  const secret =
    settings.encryptionKey || (settings.localMode ? "dev-secret" : "");
  if (!secret) {
    throw new Error(
      "ENCRYPTION_KEY is required for presigned URLs in non-local mode",
    );
  }
  const expires = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const data = `${orgId}:${key}:${expires}:GET`;
  const signature = createHmac("sha256", secret).update(data).digest("hex");
  return `${baseUrl}/api/dev-assets/${orgId}/${key}?expires=${expires}&signature=${signature}&method=GET`;
}

export function createScreenshotTool(baseUrl: string, orgId: string) {
  return tool({
    description:
      "Take a screenshot of a URL. Saves the image and returns a URL you can reference. Use this to verify page layout and visual issues.",
    inputSchema: zodSchema(InputSchema),
    execute: async (input: z.infer<typeof InputSchema>) => {
      const endpoint = resolveBrowserEndpoint();

      const pageHost = new URL(input.url).hostname;
      return withBrowserPage(
        endpoint,
        input.device,
        async (page) => {
          await page.goto(input.url, {
            waitUntil: input.waitUntil,
            timeout: input.timeout,
          });

          const buf = (await page.screenshot({
            fullPage: input.fullPage,
            encoding: "binary",
          })) as Buffer;

          if (buf.length > MAX_SCREENSHOT_BYTES) {
            return {
              url: input.url,
              device: input.device,
              error: `Screenshot too large (${Math.round(buf.length / 1024)}KB). Try with fullPage: false.`,
            };
          }

          // Save to dev-assets storage
          const sanitizedOrgId = orgId.replace(/[^a-zA-Z0-9_-]/g, "_");
          const slug = new URL(input.url).hostname.replace(/\./g, "-");
          const key = `screenshots/${slug}-${input.device}-${randomUUID().slice(0, 8)}.png`;
          const filePath = join(DEV_ASSETS_BASE_DIR, sanitizedOrgId, key);

          await mkdir(dirname(filePath), { recursive: true });
          await writeFile(filePath, buf);

          const imageUrl = generatePresignedUrl(orgId, key, baseUrl);

          return {
            url: input.url,
            device: input.device,
            sizeKB: Math.round(buf.length / 1024),
            imageUrl,
            savedTo: key,
          };
        },
        {
          cookies: input.cookies,
          domain: pageHost,
        },
      );
    },
  });
}
