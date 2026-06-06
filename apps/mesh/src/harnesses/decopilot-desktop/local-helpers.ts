/**
 * local-helpers — lean port of `api/routes/decopilot/helpers.ts`.
 *
 * Copies `toolNeedsApproval`, the name-sanitization helpers, and `toolsFromMCP`,
 * dropping the cluster-coupled pieces so this stays daemon-portable:
 *   - `resolveArgsStorageRefs` / `file-materializer` — guarded behind
 *     `ctx?.objectStorage` (always absent on the desktop, so the branch is dead
 *     here); kept out entirely to avoid the `@/object-storage/*` import.
 *   - `posthog` analytics — dropped (cluster-only `@/posthog`).
 *   - `MCP_TOOL_CALL_TIMEOUT_MS` (`@/core/constants`) — inlined as a local
 *     constant to keep the import graph free of `@/`.
 *
 * Truncation reuses the genuinely-portable `read-tool-output` leaf by relative
 * path. The narrow `DesktopToolCtx` replaces `StudioContext` everywhere.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
} from "../decopilot/built-in-tools/read-tool-output";
import type { DesktopToolCtx } from "./types";

/** Mirrors `@/core/constants:MCP_TOOL_CALL_TIMEOUT_MS`. Inlined to avoid the
 *  cluster `@/core` import. Keep in sync if the cluster value changes. */
const MCP_TOOL_CALL_TIMEOUT_MS = 120_000;

/** Tool approval levels determine which tools require user approval. */
export type ToolApprovalLevel = "auto" | "readonly";

/**
 * Determine if a tool needs approval based on approval level and readOnlyHint.
 * Copy of `helpers.ts:toolNeedsApproval` (pure — no cluster deps).
 */
function toolNeedsApproval(
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

/** Sanitize a tool name so it's accepted by all known LLM providers. */
function sanitizeToolName(name: string): string {
  let safe = name.replace(/[^a-zA-Z0-9_.\-:]/g, "_");
  if (safe.length === 0 || !/^[a-zA-Z_]/.test(safe)) {
    safe = `_${safe}`;
  }
  if (safe.length > 128) {
    safe = safe.slice(0, 128);
  }
  return safe;
}

/** Strip the GatewayClient namespace prefix from a tool name. */
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

/** Same as sanitizeToolName but also converts hyphens to underscores. */
function sanitizeForLlm(name: string): string {
  return sanitizeToolName(name).replace(/-/g, "_");
}

/**
 * Build a collision-aware name map from MCP tools. Uses the short name when
 * unique; prepends the connection prefix only on collision. Copy of
 * `helpers.ts:buildShortNameMap`.
 */
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

/** MCP Apps visibility check — default (no visibility) = visible to model. */
function isToolVisibleToModel(t: { _meta?: Record<string, unknown> }): boolean {
  const ui = t._meta?.ui as { visibility?: string | string[] } | undefined;
  const visibility = ui?.visibility;
  if (visibility == null) return true;
  if (typeof visibility === "string") return visibility === "model";
  if (Array.isArray(visibility)) return visibility.includes("model");
  return true;
}

/**
 * Convert MCP tools to an AI SDK ToolSet. Lean port of `helpers.ts:toolsFromMCP`:
 *  - no `resolveArgsStorageRefs` (storage-ref resolution is cluster-only; on the
 *    desktop `ctx.objectStorage` is always null, so the original branch was dead)
 *  - no posthog `tool_called` capture (cluster-only analytics)
 * The `data-tool-metadata` write + the output-truncation `toModelOutput` are
 * preserved byte-for-byte so the UI's latency badge + read_tool_output flow keep
 * working.
 */
export async function toolsFromMCP(
  client: Client,
  toolOutputMap: Map<string, string>,
  writer?: UIMessageStreamWriter,
  toolApprovalLevel: ToolApprovalLevel = "auto",
  options?: {
    disableOutputTruncation?: boolean;
    ctx?: DesktopToolCtx;
    isPlanMode?: boolean;
  },
): Promise<{ tools: ToolSet; nameMap: Map<string, string> }> {
  const truncate = !options?.disableOutputTruncation;
  const list = await client.listTools();
  const visibleTools = list.tools.filter(isToolVisibleToModel);

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
            isPlanMode: options?.isPlanMode,
          }) !== false,
        execute: async (input, callOptions) => {
          const startTime = performance.now();
          let outputBytes: number | undefined;
          try {
            const result = await client.callTool(
              {
                name: t.name,
                arguments: input as Record<string, unknown>,
              },
              CallToolResultSchema,
              {
                signal: callOptions.abortSignal,
                timeout: MCP_TOOL_CALL_TIMEOUT_MS,
              },
            );
            try {
              outputBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
            } catch {
              outputBytes = undefined;
            }
            return result as unknown as CallToolResult;
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

  return { tools: Object.fromEntries(toolEntries), nameMap };
}
