/**
 * local-tools — the LOCAL-OK built-in tool set for the desktop harness.
 *
 * Re-uses the genuinely-portable existing tool modules by RELATIVE path:
 *   - user_ask, todo_write   (pure AI-SDK tools, no ctx)
 *   - read_tool_output       (closure over toolOutputMap)
 *   - read_prompt            (closure over the passthrough VirtualClient)
 *   - sandbox                (closure over the passthrough VirtualClient)
 *   - enable_tool            (state-dependent; built in the agent loop, re-exported)
 *
 * For `read_resource`, `scrape_url`, and `inspect_page` the existing modules
 * import `@/core/studio-context` (type-only). That alias resolves at build but
 * threading `StudioContext` would re-introduce the recursive-type overflow — so
 * those three are re-implemented inline here against `DesktopToolCtx`, with the
 * cluster blob-offload branches removed (the desktop has no `objectStorage`).
 *
 * The 5 CLUSTER built-ins (subtask, update_interests, generate_image,
 * web_search, take_screenshot) are NEVER imported — the desktop reaches them
 * through the cluster's MCP endpoint (`mcp.url`) as passthrough tools instead.
 *
 * VM tools are SKIPPED in phase 1: `html-page-buffer.ts` imports
 * `@/object-storage/*` (not portable) and no loopback runner is wired on the
 * desktop daemon yet. `vmContext` is effectively always null here.
 */

import { tool, zodSchema, type ToolSet, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import { userAskTool } from "../decopilot/built-in-tools/user-ask";
import { todoWriteTool } from "../decopilot/built-in-tools/todo-write";
import {
  createReadToolOutputTool,
  MAX_RESULT_TOKENS,
  createOutputPreview,
  estimateJsonTokens,
} from "../decopilot/built-in-tools/read-tool-output";
import { createReadPromptTool } from "../decopilot/built-in-tools/prompts";
import {
  createSandboxTool,
  type VirtualClient,
} from "../decopilot/built-in-tools/sandbox";
import { BROWSERLESS_BASE_URL } from "../decopilot/built-in-tools/constants";
import type { DesktopToolCtx } from "./types";
import type { ToolApprovalLevel } from "./local-helpers";

// ─────────────────────────────────────────────────────────────────────
// read_resource (lean) — no mesh-storage:// blob path (cluster-only)
// ─────────────────────────────────────────────────────────────────────

function createDesktopReadResourceTool(params: {
  passthroughClient: VirtualClient;
  toolOutputMap: Map<string, string>;
}) {
  const { passthroughClient, toolOutputMap } = params;
  return tool({
    description:
      "Read a resource by its URI. Returns the content of the resource. " +
      "Resource URIs (docs://...) are provided in prompt content. ",
    inputSchema: zodSchema(
      z.object({
        uri: z
          .string()
          .min(1)
          .describe("The URI of the resource to read (e.g. docs://store.md)."),
      }),
    ),
    execute: async ({ uri }) => {
      const result = await passthroughClient.readResource({ uri });
      const contents = result.contents;

      if (!contents || contents.length === 0) {
        return { result: "Resource returned no content." };
      }

      const parts = contents.map((c) => {
        if ("text" in c && c.text !== undefined) {
          return { uri: c.uri, mimeType: c.mimeType, text: c.text };
        }
        if ("blob" in c && c.blob !== undefined) {
          return {
            uri: c.uri,
            mimeType: c.mimeType,
            blob: `[binary data, ${(c.blob as string).length} bytes base64]`,
          };
        }
        return { uri: c.uri, mimeType: c.mimeType };
      });

      const serialized = JSON.stringify(parts, null, 2);
      const tokens = estimateJsonTokens(serialized);

      if (tokens > MAX_RESULT_TOKENS) {
        const toolCallId = `resource_${Date.now()}`;
        toolOutputMap.set(toolCallId, serialized);
        const preview = createOutputPreview(serialized);
        return {
          result: `Resource content too large (${tokens} tokens). Use read_tool_output with tool_call_id "${toolCallId}" to extract specific data.\n\nPreview:\n${preview}`,
        };
      }

      return { contents: parts };
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// scrape_url (lean) — inline result only (no objectStorage offload)
// ─────────────────────────────────────────────────────────────────────

function createDesktopScrapeUrlTool(
  writer: UIMessageStreamWriter,
  params: { toolOutputMap: Map<string, string> },
) {
  const { toolOutputMap } = params;
  return tool({
    description:
      "Scrape the rendered HTML content of a web page. " +
      "Use this when you need to read the content, structure, or data from a website. " +
      "Returns the full HTML of the page after JavaScript has been executed. " +
      "For very large pages the result may be truncated — use read_tool_output to access the full content.",
    inputSchema: zodSchema(
      z.object({
        url: z.string().url().describe("The URL of the web page to scrape."),
      }),
    ),
    execute: async (input, options) => {
      const startTime = performance.now();
      try {
        const token = process.env.BROWSERLESS_TOKEN;
        if (!token) {
          return {
            success: false,
            error: "BROWSERLESS_TOKEN is not configured.",
          };
        }

        const response = await fetch(
          `${BROWSERLESS_BASE_URL}/content?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ url: input.url }),
          },
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          return {
            success: false,
            error: `Browserless content fetch failed (${response.status}): ${errorText}`,
            url: input.url,
          };
        }

        const htmlText = await response.text();
        toolOutputMap.set(options.toolCallId, htmlText);
        const tokenCount = estimateJsonTokens(htmlText);

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

// ─────────────────────────────────────────────────────────────────────
// inspect_page (lean) — inline result only (no objectStorage offload)
// ─────────────────────────────────────────────────────────────────────

function buildInspectFunctionCode(
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

function createDesktopInspectPageTool(
  writer: UIMessageStreamWriter,
  params: { toolOutputMap: Map<string, string> },
) {
  const { toolOutputMap } = params;
  return tool({
    description:
      "Inspect a web page's client-side runtime state. " +
      "Navigates to a URL and collects browser console logs, JavaScript errors, " +
      "and optionally evaluates a JS expression (e.g. window.dataLayer, document.title). " +
      "Use this for debugging client-side issues, checking analytics setup, or inspecting runtime state. " +
      "For very large results the output may be truncated — use read_tool_output to access the full content.",
    inputSchema: zodSchema(
      z.object({
        url: z.string().url().describe("The URL of the web page to inspect."),
        evaluate: z
          .string()
          .optional()
          .describe(
            "Optional JavaScript expression to evaluate in the page context after load.",
          ),
        waitUntil: z
          .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
          .optional()
          .describe(
            "When to consider navigation complete. Defaults to 'networkidle2'.",
          ),
      }),
    ),
    execute: async (input, options) => {
      const startTime = performance.now();
      try {
        const token = process.env.BROWSERLESS_TOKEN;
        if (!token) {
          return {
            success: false,
            error: "BROWSERLESS_TOKEN is not configured.",
          };
        }

        const code = buildInspectFunctionCode(input.url, {
          evaluate: input.evaluate,
          waitUntil: input.waitUntil,
        });

        const response = await fetch(
          `${BROWSERLESS_BASE_URL}/function?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/javascript" },
            body: code,
          },
        );

        if (!response.ok) {
          const errorText = await response.text().catch(() => "Unknown error");
          return {
            success: false,
            error: `Browserless function call failed (${response.status}): ${errorText}`,
            url: input.url,
          };
        }

        let result: {
          consoleLogs?: { type: string; text: string }[];
          errors?: string[];
          evaluateResult?: unknown;
        };
        try {
          result = await response.json();
        } catch {
          const text = await response.text().catch(() => "");
          return {
            success: false,
            error: `Browserless returned non-JSON response: ${text.slice(0, 200)}`,
            url: input.url,
          };
        }
        const resultJson = JSON.stringify(result, null, 2);
        toolOutputMap.set(options.toolCallId, resultJson);
        const tokenCount = estimateJsonTokens(resultJson);

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

// ─────────────────────────────────────────────────────────────────────
// Assembler
// ─────────────────────────────────────────────────────────────────────

export interface BuildLocalToolsParams {
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
  toolApprovalLevel: ToolApprovalLevel;
  isPlanMode: boolean;
  /** Narrow ctx — present for parity, but the LOCAL-OK tools only read fields
   *  that degrade safely when absent. `objectStorage` is always null. */
  ctx: DesktopToolCtx;
}

/**
 * Build the LOCAL-OK built-in tool set for the desktop harness. Returns a flat
 * ToolSet keyed by the same names the cluster uses, so the model's tool
 * vocabulary is consistent across cluster/desktop.
 *
 * `sandbox` approval honors the plan-mode / approval-level rule (it executes
 * arbitrary JS combining enabled tools, so it's treated like a write).
 */
export function buildLocalTools(params: BuildLocalToolsParams): ToolSet {
  const {
    writer,
    toolOutputMap,
    passthroughClient,
    toolApprovalLevel,
    isPlanMode,
  } = params;

  const sandboxNeedsApproval = isPlanMode || toolApprovalLevel !== "auto";

  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    todo_write: todoWriteTool,
    read_tool_output: createReadToolOutputTool({ toolOutputMap }),
    read_prompt: createReadPromptTool({ passthroughClient, toolOutputMap }),
    read_resource: createDesktopReadResourceTool({
      passthroughClient,
      toolOutputMap,
    }),
    sandbox: createSandboxTool({
      passthroughClient,
      toolOutputMap,
      needsApproval: sandboxNeedsApproval,
    }),
  };

  // scrape_url / inspect_page require Browserless — only register when the
  // token is present. Both call the external Browserless API only (no object
  // storage), so they're LOCAL-OK.
  if (process.env.BROWSERLESS_TOKEN) {
    tools.scrape_url = createDesktopScrapeUrlTool(writer, { toolOutputMap });
    tools.inspect_page = createDesktopInspectPageTool(writer, {
      toolOutputMap,
    });
  }

  return tools as ToolSet;
}
