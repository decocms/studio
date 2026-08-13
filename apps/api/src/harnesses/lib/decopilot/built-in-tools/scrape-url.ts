/**
 * scrape_url Built-in Tool
 *
 * Server-side tool that fetches the rendered HTML content of a web page
 * using Browserless v2 cloud API. Requires the BROWSERLESS_TOKEN env var.
 *
 * Small results are returned inline. Large results (> 8k tokens) are
 * offloaded to blob storage and a preview + studio-storage: URI is returned.
 * The model can re-access the full content via read_tool_output or
 * read_resource.
 */

import { tool, zodSchema, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { ObjectStorageHooks } from "../../harness-deps";
import { createOutputPreview, estimateJsonTokens } from "./read-tool-output";
import { toStudioStorageUri } from "../studio-storage-uri";
import { LARGE_RESULT_TOKEN_THRESHOLD } from "./constants";
import {
  browserlessFetch,
  BROWSERLESS_ERROR_BODY_MAX_CHARS,
  httpUrlSchema,
} from "./browserless-fetch";

const ScrapeUrlInputSchema = z.object({
  url: httpUrlSchema.describe("The URL of the web page to scrape."),
});

export type ScrapeUrlInput = z.infer<typeof ScrapeUrlInputSchema>;

export function createScrapeUrlTool(
  writer: UIMessageStreamWriter,
  params: {
    // baseUrl + token come from `deps.browserless`; presence of the hook is
    // the gate (the cluster only builds this tool when BROWSERLESS_TOKEN is
    // set). The tool no longer reads `process.env` (HarnessDeps conversion).
    browserless: { baseUrl: string; token: string };
    objectStorage: ObjectStorageHooks;
    toolOutputMap: Map<string, string>;
  },
) {
  const { browserless, objectStorage, toolOutputMap } = params;

  return tool({
    description:
      "Scrape the rendered HTML content of a web page. " +
      "Use this when you need to read the content, structure, or data from a website. " +
      "Returns the full HTML of the page after JavaScript has been executed. " +
      "For very large pages the result may be truncated — use read_tool_output to access the full content.",
    inputSchema: zodSchema(ScrapeUrlInputSchema),
    execute: async (input, options) => {
      const startTime = performance.now();
      try {
        const fetched = await browserlessFetch(
          "Browserless content fetch",
          `${browserless.baseUrl}/content?token=${encodeURIComponent(
            browserless.token,
          )}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              url: input.url,
            }),
          },
        );
        if (!fetched.ok) {
          return { success: false, error: fetched.error, url: input.url };
        }
        const response = fetched.response;

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          return {
            success: false,
            error: `Browserless content fetch failed (${response.status}): ${errorText.slice(0, BROWSERLESS_ERROR_BODY_MAX_CHARS)}`,
            url: input.url,
          };
        }

        const htmlText = await response.text();

        // Always store in toolOutputMap for read_tool_output access
        toolOutputMap.set(options.toolCallId, htmlText);

        const tokenCount = estimateJsonTokens(htmlText);

        // Large results → blob storage with preview
        if (tokenCount > LARGE_RESULT_TOKEN_THRESHOLD) {
          const key = `scraped-pages/${crypto.randomUUID()}.html`;
          const bytes = new TextEncoder().encode(htmlText);
          try {
            await objectStorage.put(key, bytes, {
              contentType: "text/html",
            });
            const preview = createOutputPreview(htmlText);
            return {
              success: true,
              uri: toStudioStorageUri(key),
              preview,
              url: input.url,
              tokenCount,
            };
          } catch (err) {
            console.error(
              "[scrape-url] Failed to upload to storage, returning inline",
              err,
            );
          }
        }

        return {
          success: true,
          content: htmlText,
          url: input.url,
          tokenCount,
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
