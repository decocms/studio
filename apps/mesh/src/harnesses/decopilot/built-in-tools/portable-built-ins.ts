import { tool, zodSchema, type ToolSet, type UIMessageStreamWriter } from "ai";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
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
import { createReadPromptTool } from "./prompts";
import { createSandboxTool, type VirtualClient } from "./sandbox";
import { BROWSERLESS_BASE_URL } from "./constants";
import type { ToolApprovalLevel } from "../mcp-tools";

interface PortableObjectStorage {
  getBytesOrPresign?: (
    key: string,
    options: { presignWhenLargerThan: number },
  ) => Promise<
    | { content: string; contentType?: string }
    | { error: string; size: number; presignedUrl: string }
  >;
}

const INLINE_RESOURCE_BYTE_LIMIT = 1_048_576;
const SUBTASK_MCP_TOOL_NAME = "SUBTASK_MCP";
const SUBTASK_TIMEOUT_MS = 600_000;

export interface PortableSubtaskModels {
  credentialId: string;
  thinking: { id: string };
  coding?: { id: string };
  fast?: { id: string };
}

export interface BuildPortableBuiltInToolsParams {
  writer: UIMessageStreamWriter;
  toolOutputMap: Map<string, string>;
  passthroughClient: VirtualClient;
  toolApprovalLevel: ToolApprovalLevel;
  isPlanMode: boolean;
  objectStorage?: PortableObjectStorage | null;
  subtaskRelay?: {
    mcpClient: Client;
    models: PortableSubtaskModels;
    selfAgentId: string;
  };
}

function parseMeshStorageKey(uri: string): string | null {
  const prefix = "mesh-storage://";
  return uri.startsWith(prefix) ? uri.slice(prefix.length) : null;
}

function createPortableReadResourceTool(params: {
  passthroughClient: VirtualClient;
  toolOutputMap: Map<string, string>;
  objectStorage?: PortableObjectStorage | null;
}) {
  const { passthroughClient, toolOutputMap, objectStorage } = params;
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
      const meshKey = parseMeshStorageKey(uri);
      if (meshKey !== null) {
        if (!objectStorage?.getBytesOrPresign) {
          return { result: "Object storage is not configured." };
        }
        try {
          const data = await objectStorage.getBytesOrPresign(meshKey, {
            presignWhenLargerThan: INLINE_RESOURCE_BYTE_LIMIT,
          });
          if ("error" in data) {
            return {
              result: `Resource too large to inline (${data.size} bytes). Presigned URL: ${data.presignedUrl}`,
            };
          }
          const text = data.content;
          const tokens = estimateJsonTokens(text);
          if (tokens > MAX_RESULT_TOKENS) {
            const toolCallId = `resource_${Date.now()}`;
            toolOutputMap.set(toolCallId, text);
            const preview = createOutputPreview(text);
            return {
              result: `Resource content too large (${tokens} tokens). Use read_tool_output with tool_call_id "${toolCallId}" to extract specific data.\n\nPreview:\n${preview}`,
            };
          }
          return {
            contents: [
              { uri, mimeType: data.contentType || "text/markdown", text },
            ],
          };
        } catch (err) {
          return {
            result: `Failed to read resource: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

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

function createPortableBrowserlessTool(
  writer: UIMessageStreamWriter,
  params: {
    toolOutputMap: Map<string, string>;
    kind: "scrape" | "inspect";
  },
) {
  const { toolOutputMap, kind } = params;
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
          return {
            success: true,
            content: htmlText,
            url: input.url,
            tokenCount: estimateJsonTokens(htmlText),
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
        return {
          success: !("error" in result),
          ...result,
          url: inspectInput.url,
          tokenCount: estimateJsonTokens(resultJson),
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

function extractSubtaskText(res: CallToolResult): string | undefined {
  const structured = (
    res as { structuredContent?: { result?: string; finishReason?: string } }
  ).structuredContent;
  if (typeof structured?.result === "string" && structured.result.length > 0) {
    return structured.result;
  }
  const text = (res.content ?? [])
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n\n")
    .trim();
  return text.length > 0 ? text : undefined;
}

function createSubtaskRelayTool(params: {
  writer: UIMessageStreamWriter;
  mcpClient: Client;
  models: PortableSubtaskModels;
  selfAgentId: string;
  needsApproval: boolean;
}) {
  const { writer, mcpClient, models, selfAgentId, needsApproval } = params;
  return tool({
    description:
      "Run a focused task in a fresh subagent that works independently and returns only its conclusion.",
    needsApproval,
    inputSchema: zodSchema(
      z.object({
        prompt: z.string().min(1).max(50_000),
        agent_id: z.string().min(1).max(128).optional(),
      }),
    ),
    execute: async ({ prompt, agent_id }, options) => {
      const startTime = performance.now();
      try {
        const res = (await mcpClient.callTool(
          {
            name: SUBTASK_MCP_TOOL_NAME,
            arguments: {
              prompt,
              agent_id: agent_id ?? selfAgentId,
              credentialId: models.credentialId,
              thinkingModelId: models.thinking.id,
              ...(models.coding ? { codingModelId: models.coding.id } : {}),
              ...(models.fast ? { fastModelId: models.fast.id } : {}),
            },
          },
          CallToolResultSchema,
          { signal: options.abortSignal, timeout: SUBTASK_TIMEOUT_MS },
        )) as CallToolResult;
        return {
          result: extractSubtaskText(res) ?? "Subtask completed (no output).",
        };
      } finally {
        writer.write({
          type: "data-tool-metadata",
          id: options.toolCallId,
          data: { latencyMs: performance.now() - startTime },
        });
      }
    },
    toModelOutput: ({ output }) => ({
      type: "text" as const,
      value:
        (output as { result?: string } | undefined)?.result?.trim() ||
        "Subtask completed (no output).",
    }),
  });
}

export function buildPortableBuiltInTools(
  params: BuildPortableBuiltInToolsParams,
): ToolSet {
  const {
    writer,
    toolOutputMap,
    passthroughClient,
    toolApprovalLevel,
    isPlanMode,
    objectStorage,
    subtaskRelay,
  } = params;
  const sandboxNeedsApproval = isPlanMode || toolApprovalLevel !== "auto";
  const tools: Record<string, unknown> = {
    user_ask: userAskTool,
    todo_write: todoWriteTool,
    propose_plan: proposePlanTool,
    read_tool_output: createReadToolOutputTool({ toolOutputMap }),
    read_resource: createPortableReadResourceTool({
      passthroughClient,
      toolOutputMap,
      objectStorage,
    }),
    read_prompt: createReadPromptTool({ passthroughClient, toolOutputMap }),
    sandbox: createSandboxTool({
      passthroughClient,
      toolOutputMap,
      needsApproval: sandboxNeedsApproval,
    }),
  };

  if (subtaskRelay) {
    tools.subtask = createSubtaskRelayTool({
      writer,
      ...subtaskRelay,
      needsApproval: sandboxNeedsApproval,
    });
  }

  if (process.env.BROWSERLESS_TOKEN) {
    tools.scrape_url = createPortableBrowserlessTool(writer, {
      toolOutputMap,
      kind: "scrape",
    });
    tools.inspect_page = createPortableBrowserlessTool(writer, {
      toolOutputMap,
      kind: "inspect",
    });
  }

  return tools as ToolSet;
}
