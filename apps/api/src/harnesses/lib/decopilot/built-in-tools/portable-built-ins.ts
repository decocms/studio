import { tool, zodSchema, type ToolSet, type UIMessageStreamWriter } from "ai";
import { z } from "zod";
import { userAskTool } from "./user-ask";
import { todoWriteTool } from "./todo-write";
import { proposePlanTool } from "./propose-plan";
import {
  createOutputPreview,
  createReadToolOutputTool,
  estimateJsonTokens,
  MAX_RESULT_TOKENS,
} from "./read-tool-output";
import { type VirtualClient } from "./sandbox";
import { BROWSERLESS_BASE_URL } from "./constants";
import type { ToolApprovalLevel } from "../mcp-tools";
import { toStudioStorageUri } from "../studio-storage-uri";
import {
  createPortableGenerateImageTool,
  createPortableTakeScreenshotTool,
  GenerateImageInputSchema,
  type PortableImageModelInfo,
  type PortableImageProvider,
  type PortableMediaObjectStorage,
} from "./portable-media-tools";
import { makeBackgroundable } from "./backgroundable";
import type { PendingImage } from "./vm-tools/types";

interface PortableObjectStorage extends PortableMediaObjectStorage {
  getBytesOrPresign?: (
    key: string,
    options: { presignWhenLargerThan: number },
  ) => Promise<
    | { content: string; contentType?: string }
    | { error: string; size: number; presignedUrl: string }
  >;
}

export interface BuildPortableBuiltInToolsParams {
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
  toolApprovalLevel: ToolApprovalLevel;
  isPlanMode: boolean;
  objectStorage?: PortableObjectStorage | null;
  pendingImages?: PendingImage[];
  imageTool?: {
    provider: PortableImageProvider;
    imageModelInfo: PortableImageModelInfo;
  };
}

function createPortableBrowserlessTool(
  writer: UIMessageStreamWriter,
  params: {
    toolOutputMap: Map<string, string>;
    objectStorage?: PortableObjectStorage | null;
    kind: "scrape" | "inspect";
  },
) {
  const { toolOutputMap, objectStorage, kind } = params;
  const inputSchema =
    kind === "scrape"
      ? z.object({
          url: z.string().url().describe("The URL of the web page to scrape."),
        })
      : z.object({
          url: z.string().url().describe("The URL of the web page to inspect."),
          evaluate: z
            .string()
            .optional()
            .describe("Optional JavaScript expression to evaluate."),
          waitUntil: z
            .enum(["load", "domcontentloaded", "networkidle0", "networkidle2"])
            .optional()
            .describe("When to consider navigation complete."),
        });

  return tool({
    description:
      kind === "scrape"
        ? "Scrape the rendered HTML content of a web page."
        : "Inspect a web page's client-side runtime state.",
    inputSchema: zodSchema(inputSchema),
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

        if (kind === "scrape") {
          const response = await fetch(
            `${BROWSERLESS_BASE_URL}/content?token=${encodeURIComponent(token)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url: input.url }),
            },
          );
          if (!response.ok) {
            const errorText = await response
              .text()
              .catch(() => "Unknown error");
            return {
              success: false,
              error: `Browserless content fetch failed (${response.status}): ${errorText}`,
              url: input.url,
            };
          }
          const htmlText = await response.text();
          toolOutputMap.set(options.toolCallId, htmlText);
          const tokenCount = estimateJsonTokens(htmlText);
          if (tokenCount > MAX_RESULT_TOKENS && objectStorage) {
            const key = `scraped-pages/${crypto.randomUUID()}.html`;
            await objectStorage.put(key, new TextEncoder().encode(htmlText), {
              contentType: "text/html",
            });
            return {
              success: true,
              uri: toStudioStorageUri(key),
              preview: createOutputPreview(htmlText),
              url: input.url,
              tokenCount,
            };
          }
          return {
            success: true,
            content: htmlText,
            url: input.url,
            tokenCount,
          };
        }

        const inspectInput = input as {
          url: string;
          evaluate?: string;
          waitUntil?: string;
        };
        const waitUntil = inspectInput.waitUntil ?? "networkidle2";
        const evaluateExpr = inspectInput.evaluate
          ? JSON.stringify(inspectInput.evaluate)
          : "null";
        const code = `
          export default async function ({ page }) {
            const consoleLogs = [];
            const errors = [];
            page.on("console", (msg) => consoleLogs.push({ type: msg.type(), text: msg.text() }));
            page.on("pageerror", (err) => errors.push(err.message || String(err)));
            await page.goto(${JSON.stringify(inspectInput.url)}, { waitUntil: ${JSON.stringify(waitUntil)}, timeout: 30000 });
            let evaluateResult = null;
            const expr = ${evaluateExpr};
            if (expr) {
              try { evaluateResult = await page.evaluate(expr); }
              catch (e) { evaluateResult = { error: e.message || String(e) }; }
            }
            return { consoleLogs, errors, evaluateResult };
          }
        `;
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
            url: inspectInput.url,
          };
        }
        const result = await response.json().catch(async () => {
          const text = await response.text().catch(() => "");
          return {
            error: `Browserless returned non-JSON response: ${text.slice(0, 200)}`,
          };
        });
        const resultJson = JSON.stringify(result, null, 2);
        toolOutputMap.set(options.toolCallId, resultJson);
        const tokenCount = estimateJsonTokens(resultJson);
        if (
          !("error" in result) &&
          tokenCount > MAX_RESULT_TOKENS &&
          objectStorage
        ) {
          const key = `inspect-pages/${crypto.randomUUID()}.json`;
          await objectStorage.put(key, new TextEncoder().encode(resultJson), {
            contentType: "application/json",
          });
          return {
            success: true,
            uri: toStudioStorageUri(key),
            preview: createOutputPreview(resultJson),
            url: inspectInput.url,
            tokenCount,
            consoleLogCount:
              (result as { consoleLogs?: unknown[] }).consoleLogs?.length ?? 0,
            errorCount: (result as { errors?: unknown[] }).errors?.length ?? 0,
            hasEvaluateResult:
              (result as { evaluateResult?: unknown }).evaluateResult != null,
          };
        }
        return {
          success: !("error" in result),
          ...result,
          url: inspectInput.url,
          tokenCount,
        };
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

export function buildPortableBuiltInTools(
  params: BuildPortableBuiltInToolsParams,
): ToolSet {
  const { writer, toolOutputMap, objectStorage, pendingImages, imageTool } =
    params;
  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    todo_write: todoWriteTool,
    propose_plan: proposePlanTool,
    read_tool_output: createReadToolOutputTool({ toolOutputMap }),
  };

  if (imageTool) {
    tools.generate_image = makeBackgroundable(
      "generate_image",
      GenerateImageInputSchema,
      createPortableGenerateImageTool(writer, {
        ...imageTool,
        objectStorage,
      }),
      null,
    );
  }

  if (process.env.BROWSERLESS_TOKEN) {
    tools.scrape_url = createPortableBrowserlessTool(writer, {
      toolOutputMap,
      objectStorage,
      kind: "scrape",
    });
    tools.inspect_page = createPortableBrowserlessTool(writer, {
      toolOutputMap,
      objectStorage,
      kind: "inspect",
    });
    if (pendingImages) {
      tools.take_screenshot = createPortableTakeScreenshotTool(writer, {
        objectStorage,
        toolOutputMap,
        pendingImages,
      });
    }
  }

  return tools as ToolSet;
}
