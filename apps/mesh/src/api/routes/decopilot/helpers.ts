/**
 * Decopilot Helper Functions
 *
 * Utility functions for request validation, context management, and tool conversion.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  jsonSchema,
  type JSONSchema7,
  type JSONValue,
  tool,
  type ToolSet,
  type UIMessageStreamWriter,
} from "ai";
import type { Context } from "hono";

import type { MeshContext, OrganizationScope } from "@/core/mesh-context";
import { HTTPException } from "hono/http-exception";
import { MCP_TOOL_CALL_TIMEOUT_MS } from "../proxy";
import { estimateJsonTokens } from "./built-in-tools/read-tool-output";

/**
 * Tool approval levels determine which tools require user approval before executing
 */
export type ToolApprovalLevel = "none" | "readonly" | "yolo";

/**
 * Determine if a tool needs approval based on approval level and readOnlyHint
 *
 * @param level - The approval level setting
 * @param readOnlyHint - Optional hint from MCP tool annotations
 * @returns true if the tool requires approval, false if auto-approved
 */
export function toolNeedsApproval(
  level: ToolApprovalLevel,
  readOnlyHint?: boolean,
): boolean {
  if (level === "yolo") return false;
  if (level === "none") return true;
  // "readonly": auto-approve only if explicitly marked readOnly
  return readOnlyHint !== true;
}

/**
 * Ensure organization context exists and matches route param
 */
export function ensureOrganization(
  c: Context<{ Variables: { meshContext: MeshContext } }>,
): OrganizationScope {
  const organization = c.get("meshContext").organization;
  if (!organization) {
    throw new Error("Organization context is required");
  }
  if ((organization.slug ?? organization.id) !== c.req.param("org")) {
    throw new Error("Organization mismatch");
  }
  return organization;
}

/**
 * Convert MCP tools to AI SDK ToolSet
 */
export async function toolsFromMCP(
  client: Client,
  toolOutputMap: Map<string, string>,
  writer?: UIMessageStreamWriter,
  toolApprovalLevel: ToolApprovalLevel = "none",
  options?: { disableOutputTruncation?: boolean },
): Promise<ToolSet> {
  const truncate = !options?.disableOutputTruncation;
  const list = await client.listTools();

  const toolEntries = list.tools.map((t) => {
    const { name, title, description, inputSchema, annotations, _meta } = t;

    return [
      name,
      tool<Record<string, unknown>, CallToolResult>({
        title: title ?? name,
        description,
        inputSchema: jsonSchema(inputSchema as JSONSchema7),
        outputSchema: undefined,
        needsApproval: toolNeedsApproval(
          toolApprovalLevel,
          annotations?.readOnlyHint,
        ),
        execute: async (input, options) => {
          const startTime = performance.now();
          try {
            const result = await client.callTool(
              {
                name: t.name,
                arguments: input as Record<string, unknown>,
              },
              CallToolResultSchema,
              {
                signal: options.abortSignal,
                timeout: MCP_TOOL_CALL_TIMEOUT_MS,
              },
            );
            return result as unknown as CallToolResult;
          } finally {
            if (writer) {
              const latencyMs = performance.now() - startTime;
              writer.write({
                type: "data-tool-metadata",
                id: options.toolCallId,
                data: {
                  _meta,
                  annotations,
                  latencyMs,
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
            if (tokens > 4000) {
              toolOutputMap.set(
                toolCallId,
                JSON.stringify(output.structuredContent ?? output.content),
              );

              return {
                type: "text",
                value: `Tool call ${toolCallId} output is too long to display (${tokens} tokens), use the read_tool_output tool`,
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
          // Convert MCP content parts to text for the model output.
          // "content" is not a valid AI SDK output type — using it causes
          // downstream providers (e.g. xAI) to reject the serialized prompt
          // with a 422 deserialization error on the next step.
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

  return Object.fromEntries(toolEntries);
}

/**
 * Shared thread validation: resolves auth, org, and thread from the request.
 * Does NOT check ownership or membership — callers decide the access policy.
 */
async function resolveThread(
  c: Context<{ Variables: { meshContext: MeshContext } }>,
) {
  const ctx = c.get("meshContext");
  const userId = ctx.auth?.user?.id;
  if (!userId) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  const organization = ensureOrganization(c);
  const threadId = c.req.param("threadId");
  if (!threadId) {
    throw new HTTPException(400, { message: "Missing thread ID" });
  }
  if (/[.*>\s]/.test(threadId)) {
    throw new HTTPException(400, { message: "Invalid thread ID" });
  }
  const thread = await ctx.storage.threads.get(threadId);
  if (!thread || thread.organization_id !== organization.id) {
    throw new HTTPException(404, { message: "Thread not found" });
  }
  return { ctx, organization, thread, threadId, userId };
}

/**
 * Validate that the caller owns the thread.
 * Reusable across cancel and other owner-only endpoints.
 */
export async function validateThreadOwnership(
  c: Context<{ Variables: { meshContext: MeshContext } }>,
) {
  const resolved = await resolveThread(c);
  if (resolved.thread.created_by !== resolved.userId) {
    throw new HTTPException(403, { message: "Not authorized" });
  }
  return resolved;
}

/**
 * Validate that the caller owns or is a shared member of the thread.
 * Use for endpoints where shared members should have read-only access (e.g. attach).
 */
export async function validateThreadAccess(
  c: Context<{ Variables: { meshContext: MeshContext } }>,
) {
  const resolved = await resolveThread(c);
  const isOwner = resolved.thread.created_by === resolved.userId;
  if (!isOwner) {
    const isMember = await resolved.ctx.storage.threads.isMember(
      resolved.threadId,
      resolved.userId,
    );
    if (!isMember) {
      throw new HTTPException(403, { message: "Not authorized" });
    }
  }
  return { ...resolved, isOwner };
}
