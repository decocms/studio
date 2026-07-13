/**
 * Corrective hints for invalid tool-call arguments.
 *
 * When an upstream MCP server rejects a `tools/call` with JSON-RPC -32602
 * (InvalidParams), the raw error is often terse ("startDate: Required") and the
 * agent keeps retrying with the same bad shape. Since the proxy already holds
 * the tool's advertised `inputSchema`, we append a concrete correction so the
 * model can fix the arguments on the next attempt.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export interface ToolInputSchema {
  required?: string[];
  properties?: Record<string, { type?: string }>;
}

/**
 * Build a one-line correction from the tool's input schema and what the agent
 * actually sent. Pure: given the same inputs, always the same string.
 */
export function buildValidationHint(
  toolName: string,
  schema: ToolInputSchema | undefined,
  args: Record<string, unknown> | undefined,
): string {
  const sent = Object.keys(args ?? {});
  const required = schema?.required ?? [];
  const missing = required.filter((k) => !sent.includes(k));

  const describe = (name: string) => {
    const type = schema?.properties?.[name]?.type;
    return type ? `${name} (${type})` : name;
  };

  const parts = [
    `Invalid arguments for "${toolName}".`,
    required.length ? `Required: ${required.map(describe).join(", ")}.` : "",
    `You sent: ${sent.length ? sent.join(", ") : "(none)"}.`,
    missing.length ? `Missing required: ${missing.join(", ")}.` : "",
  ];

  return parts.filter(Boolean).join(" ");
}

/**
 * If `err` is an InvalidParams McpError, return a new McpError with a
 * schema-derived correction appended to the message. Any other error (or a
 * missing tool name) passes through unchanged.
 */
export function enrichInvalidParams(
  err: unknown,
  toolName: string | undefined,
  schema: ToolInputSchema | undefined,
  args: Record<string, unknown> | undefined,
): unknown {
  if (!(err instanceof McpError) || err.code !== ErrorCode.InvalidParams) {
    return err;
  }
  if (!toolName) return err;

  const hint = buildValidationHint(toolName, schema, args);
  // McpError's constructor re-adds the "MCP error <code>: " prefix, so strip
  // the one already on err.message to avoid a doubled header.
  const raw = err.message.replace(/^MCP error -?\d+: /, "");
  return new McpError(ErrorCode.InvalidParams, `${raw}\n\n${hint}`, err.data);
}
