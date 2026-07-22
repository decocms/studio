import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  jsonSchema,
  type JSONSchema7,
  type JSONValue,
  tool,
  type ToolSet,
  type UIMessageStreamWriter,
} from "ai";
import {
  MAX_RESULT_TOKENS,
  createOutputPreview,
  estimateJsonTokens,
} from "./built-in-tools/read-tool-output";

const DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS = 120_000;

export type ToolApprovalLevel = "auto" | "readonly";

export function toolNeedsApproval(
  level: ToolApprovalLevel,
  readOnlyHint?: boolean,
  options?: { isPlanMode?: boolean },
): boolean | "hard-block" {
  if (options?.isPlanMode) {
    if (readOnlyHint === true) return false;
    return "hard-block";
  }
  if (level === "auto") return false;
  return readOnlyHint !== true;
}

export function sanitizeToolName(name: string): string {
  let safe = name.replace(/[^a-zA-Z0-9_.\-:]/g, "_");
  if (safe.length === 0 || !/^[a-zA-Z_]/.test(safe)) {
    safe = `_${safe}`;
  }
  if (safe.length > 128) {
    safe = safe.slice(0, 128);
  }
  return safe;
}

export function buildSanitizedNameMap(names: string[]): Map<string, string> {
  const map = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const name of names) {
    let safeName = sanitizeToolName(name);
    if (usedNames.has(safeName)) {
      const maxBase = 128 - 4;
      const base =
        safeName.length > maxBase ? safeName.slice(0, maxBase) : safeName;
      let i = 2;
      while (usedNames.has(`${base}_${i}`)) i++;
      safeName = `${base}_${i}`;
    }
    usedNames.add(safeName);
    map.set(name, safeName);
  }
  return map;
}

function stripGatewayPrefix(
  namespacedName: string,
  gatewayClientId: string,
): string {
  const slug = gatewayClientId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const prefix = `${slug}_`;
  return namespacedName.startsWith(prefix)
    ? namespacedName.slice(prefix.length)
    : namespacedName;
}

function sanitizeForLlm(name: string): string {
  return sanitizeToolName(name).replace(/-/g, "_");
}

function buildShortNameMap(
  tools: Array<{ name: string; _meta?: Record<string, unknown> }>,
): Map<string, string> {
  const shortCount = new Map<string, number>();
  for (const t of tools) {
    const connId =
      typeof t._meta?.gatewayClientId === "string"
        ? t._meta.gatewayClientId
        : "";
    const short = connId ? stripGatewayPrefix(t.name, connId) : t.name;
    const safe = sanitizeForLlm(short);
    shortCount.set(safe, (shortCount.get(safe) ?? 0) + 1);
  }

  const used = new Set<string>();
  const map = new Map<string, string>();
  for (const t of tools) {
    const connId =
      typeof t._meta?.gatewayClientId === "string"
        ? t._meta.gatewayClientId
        : "";
    const short = connId ? stripGatewayPrefix(t.name, connId) : t.name;
    const safeShort = sanitizeForLlm(short);
    const unique = (shortCount.get(safeShort) ?? 0) <= 1;

    let safeName = unique ? safeShort : sanitizeForLlm(`${connId}_${short}`);

    if (used.has(safeName)) {
      const base = safeName.slice(0, 124);
      let i = 2;
      while (used.has(`${base}_${i}`)) i++;
      safeName = `${base}_${i}`;
    }

    used.add(safeName);
    map.set(t.name, safeName);
  }
  return map;
}

function defaultToolVisibility(tool: {
  _meta?: Record<string, unknown>;
}): boolean {
  const ui = tool._meta?.ui as { visibility?: string | string[] } | undefined;
  const visibility = ui?.visibility;
  if (visibility == null) return true;
  if (typeof visibility === "string") return visibility === "model";
  if (Array.isArray(visibility)) return visibility.includes("model");
  return true;
}

export interface ToolCallAnalytics {
  toolName: string;
  toolSafeName: string;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  latencyMs: number;
  isError: boolean;
}

/**
 * A successful `create_pull_request` MCP tool call — carries the result (which
 * holds the PR URL) and the source connection id, so a consumer can extract the
 * PR identity and link it to a task. Distinct from `onToolCalled` (analytics,
 * which deliberately carries no result). Fired only for PR-create tools (coarse
 * name gate below) so the result is never forwarded for ordinary tool calls.
 */
export interface PrOpenedEvent {
  toolName: string;
  /** Source connection id (gateway client id), when known. */
  connectionId?: string;
  input: Record<string, unknown>;
  result: CallToolResult;
}

/** Coarse, cheap pre-filter: does this tool name look like a PR-create tool?
 *  The consumer applies the precise check — this just keeps `onPrOpened` from
 *  firing (and forwarding the result) on every ordinary tool call. */
function looksLikePrCreateTool(name: string): boolean {
  return (
    name.includes("create_pull_request") || name.includes("createPullRequest")
  );
}

export interface ToolsFromMcpOptions {
  disableOutputTruncation?: boolean;
  isPlanMode?: boolean;
  timeoutMs?: number;
  isToolVisible?: (tool: {
    name: string;
    _meta?: Record<string, unknown>;
  }) => boolean;
  resolveArgs?: (
    input: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  onToolCalled?: (event: ToolCallAnalytics) => void;
  onPrOpened?: (event: PrOpenedEvent) => void;
}

export async function toolsFromMCP(
  client: Client,
  toolOutputMap: Map<string, string>,
  writer?: UIMessageStreamWriter,
  toolApprovalLevel: ToolApprovalLevel = "auto",
  options: ToolsFromMcpOptions = {},
): Promise<{
  tools: ToolSet;
  nameMap: Map<string, string>;
  rawTools: Awaited<ReturnType<Client["listTools"]>>["tools"];
}> {
  const truncate = !options.disableOutputTruncation;
  const list = await client.listTools();
  const visibleTools = list.tools.filter((t) =>
    (options.isToolVisible ?? defaultToolVisibility)(t),
  );

  const nameMap = buildShortNameMap(visibleTools);
  const toolEntries = visibleTools.map((t) => {
    const { name, title, description, inputSchema, annotations, _meta } = t;
    const safeName = nameMap.get(name)!;

    return [
      safeName,
      tool<Record<string, unknown>, CallToolResult>({
        title: title ?? name,
        description,
        inputSchema: jsonSchema(inputSchema as JSONSchema7),
        outputSchema: undefined,
        needsApproval:
          toolNeedsApproval(toolApprovalLevel, annotations?.readOnlyHint, {
            isPlanMode: options.isPlanMode,
          }) !== false,
        execute: async (input, callOptions) => {
          const startTime = performance.now();
          let isError = false;
          let outputBytes: number | undefined;
          try {
            const resolvedInput = options.resolveArgs
              ? await options.resolveArgs(input as Record<string, unknown>)
              : (input as Record<string, unknown>);
            const result = await client.callTool(
              {
                name: t.name,
                arguments: resolvedInput,
              },
              CallToolResultSchema,
              {
                signal: callOptions.abortSignal,
                timeout: options.timeoutMs ?? DEFAULT_MCP_TOOL_CALL_TIMEOUT_MS,
              },
            );
            isError = Boolean((result as { isError?: boolean })?.isError);
            try {
              outputBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
            } catch {
              outputBytes = undefined;
            }
            // A PR was just opened via the GitHub MCP — hand the result (holds
            // the PR URL) + source connection to the consumer for linking.
            if (
              !isError &&
              options.onPrOpened &&
              looksLikePrCreateTool(t.name)
            ) {
              options.onPrOpened({
                toolName: t.name,
                connectionId: (_meta as { gatewayClientId?: string })
                  ?.gatewayClientId,
                input: resolvedInput,
                result: result as unknown as CallToolResult,
              });
            }
            return result as unknown as CallToolResult;
          } catch (err) {
            isError = true;
            throw err;
          } finally {
            const latencyMs = performance.now() - startTime;
            if (writer) {
              writer.write({
                type: "data-tool-metadata",
                id: callOptions.toolCallId,
                data: {
                  _meta,
                  annotations,
                  latencyMs,
                  outputBytes,
                },
              });
            }
            options.onToolCalled?.({
              toolName: t.name,
              toolSafeName: safeName,
              annotations,
              latencyMs,
              isError,
            });
          }
        },
        toModelOutput: async ({ output, toolCallId }) => {
          if (truncate) {
            const tokens = estimateJsonTokens(
              output.structuredContent ?? output.content,
            );
            if (tokens > MAX_RESULT_TOKENS) {
              const value = output.structuredContent ?? output.content;
              let raw: string;
              try {
                raw = JSON.stringify(value, null, 2);
              } catch {
                raw = String(value);
              }
              toolOutputMap.set(toolCallId, raw);
              const preview = createOutputPreview(raw);

              return {
                type: "text",
                value: `Tool call ${toolCallId} output is too long to display (${tokens} tokens), use the read_tool_output tool.\n\nPreview:\n${preview}`,
              };
            }
          }
          if (output.isError) {
            const textContent = output.content
              .map((c) => (c.type === "text" ? c.text : null))
              .filter(Boolean)
              .join("\n");
            return {
              type: "error-text",
              value: textContent || "Unknown error",
            };
          }
          if ("structuredContent" in output) {
            return {
              type: "json",
              value: output.structuredContent as JSONValue,
            };
          }
          const textValue = output.content
            .map((c) => {
              if (c.type === "text") return c.text;
              return JSON.stringify(c);
            })
            .join("\n");
          return { type: "text", value: textValue };
        },
      }),
    ];
  });

  // Return the raw listing too: callers otherwise re-call client.listTools(),
  // doubling the list+parse pass over the full tool surface every run — costly
  // at high tool counts (100s of tools).
  return {
    tools: Object.fromEntries(toolEntries),
    nameMap,
    rawTools: list.tools,
  };
}
