/**
 * inspect_page Built-in Tool
 *
 * Server-side tool that navigates to a URL using Browserless v2 Function API,
 * collects console logs and JS errors during page load, and optionally
 * evaluates a JavaScript expression in the page context.
 *
 * Requires the BROWSERLESS_TOKEN env var.
 *
 * Small results are returned inline. Large results (> 8k tokens) are
 * offloaded to blob storage and a preview + studio-storage: URI is returned.
 * The model can re-access the full content via read_tool_output or
 * read_resource.
 */

import { tool, zodSchema, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import type { ObjectStorageHooks } from "../../harness-deps";
import { estimateJsonTokens, offloadLargeResult } from "./read-tool-output";
import { LARGE_RESULT_TOKEN_THRESHOLD } from "./constants";
import {
  browserlessFetch,
  BROWSERLESS_ERROR_BODY_MAX_CHARS,
  httpUrlSchema,
} from "./browserless-fetch";

const InspectPageInputSchema = z.object({
  url: httpUrlSchema.describe("The URL of the web page to inspect."),
  evaluate: z
    .string()
    .optional()
    .describe(
      "Optional JavaScript expression to evaluate in the page context after load. " +
        "Examples: 'window.dataLayer', 'document.querySelectorAll(\"script\").length', " +
        "'performance.getEntriesByType(\"resource\").map(e => ({name: e.name, duration: e.duration}))'",
    ),
  waitUntil: z
    .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
    .optional()
    .describe(
      "When to consider navigation complete. Defaults to 'networkidle2'.",
    ),
});

export type InspectPageInput = z.infer<typeof InspectPageInputSchema>;

/**
 * Build the Puppeteer function code string sent to Browserless /function API.
 * The function collects console logs, JS errors, navigates, and optionally
 * evaluates a JS expression.
 */
function buildFunctionCode(
  url: string,
  options: { evaluate?: string; waitUntil?: string },
): string {
  const waitUntil = options.waitUntil ?? "networkidle2";
  const evaluateExpr = options.evaluate
    ? JSON.stringify(options.evaluate)
    : "null";

  return `
    export default async function ({ page }) {
      const consoleLogs = [];
      const errors = [];

      page.on("console", (msg) => {
        consoleLogs.push({ type: msg.type(), text: msg.text() });
      });

      page.on("pageerror", (err) => {
        errors.push(err.message || String(err));
      });

      await page.goto(${JSON.stringify(url)}, {
        waitUntil: ${JSON.stringify(waitUntil)},
        timeout: 30000,
      });

      let evaluateResult = null;
      const expr = ${evaluateExpr};
      if (expr) {
        try {
          evaluateResult = await page.evaluate(expr);
        } catch (e) {
          evaluateResult = { error: e.message || String(e) };
        }
      }

      return { consoleLogs, errors, evaluateResult };
    }
  `;
}

export function createInspectPageTool(
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
      "Inspect a web page's client-side runtime state. " +
      "Navigates to a URL and collects browser console logs, JavaScript errors, " +
      "and optionally evaluates a JS expression (e.g. window.dataLayer, document.title). " +
      "Use this for debugging client-side issues, checking analytics setup, or inspecting runtime state. " +
      "For very large results the output may be truncated — use read_tool_output to access the full content.",
    inputSchema: zodSchema(InspectPageInputSchema),
    execute: async (input, options) => {
      const startTime = performance.now();
      try {
        const code = buildFunctionCode(input.url, {
          evaluate: input.evaluate,
          waitUntil: input.waitUntil,
        });

        const fetched = await browserlessFetch(
          "Browserless function call",
          `${browserless.baseUrl}/function?token=${encodeURIComponent(
            browserless.token,
          )}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/javascript" },
            body: code,
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
            error: `Browserless function call failed (${response.status}): ${errorText.slice(0, BROWSERLESS_ERROR_BODY_MAX_CHARS)}`,
            url: input.url,
          };
        }

        // Read as text first so a failed parse can still report the raw body.
        const rawText = await response.text();
        let result: {
          consoleLogs?: { type: string; text: string }[];
          errors?: string[];
          evaluateResult?: unknown;
        };
        try {
          result = JSON.parse(rawText);
        } catch {
          return {
            success: false,
            error: `Browserless returned non-JSON response: ${rawText.slice(0, 200)}`,
            url: input.url,
          };
        }
        const resultJson = JSON.stringify(result, null, 2);

        // Always store in toolOutputMap for read_tool_output access
        toolOutputMap.set(options.toolCallId, resultJson);

        const tokenCount = estimateJsonTokens(resultJson);

        // Large results → blob storage with preview
        if (tokenCount > LARGE_RESULT_TOKEN_THRESHOLD) {
          const offloaded = await offloadLargeResult(
            objectStorage,
            `inspect-pages/${crypto.randomUUID()}.json`,
            resultJson,
            "application/json",
            "inspect-page",
          );
          if (offloaded) {
            return {
              success: true,
              uri: offloaded.uri,
              preview: offloaded.preview,
              url: input.url,
              tokenCount,
              consoleLogCount: result.consoleLogs?.length ?? 0,
              errorCount: result.errors?.length ?? 0,
              hasEvaluateResult: result.evaluateResult != null,
            };
          }
        }

        return {
          success: true,
          consoleLogs: result.consoleLogs,
          errors: result.errors,
          evaluateResult: result.evaluateResult,
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
