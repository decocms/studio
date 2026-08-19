/**
 * Repair and explain invalid tool-call arguments.
 *
 * When an upstream MCP server rejects a `tools/call` for -32602 (InvalidParams),
 * the raw error is terse ("startDate: Required") and the agent keeps retrying
 * the same bad shape. The proxy holds the tool's advertised `inputSchema`, so it
 * can do better: re-type the arguments the model plainly got wrong
 * (`coerceArgsToSchema`) and retry, and failing that append a concrete
 * correction (`buildValidationHint`) so the next attempt can fix them.
 *
 * A rejection arrives in one of two shapes, and both must be handled:
 *  - a thrown JSON-RPC error   → `enrichInvalidParams`
 *  - an `isError: true` result → `invalidParamsResultText` / `appendHintToResult`
 * The MCP SDK's own server (>= 1.29) catches the validation `McpError` in its
 * `tools/call` handler and returns the second shape, so the throw path alone
 * misses every server built on it.
 */

import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";

export interface ToolInputSchema {
  required?: string[];
  properties?: Record<string, { type?: string }>;
}

/** The JSON Schema `type` name for a runtime value. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * Whether `value` satisfies a declared JSON Schema `type`. JSON Schema's
 * "integer" is a whole-number `number`, not a distinct JS runtime type —
 * `jsonTypeOf` alone would call a correctly-sent `5` a type mismatch because
 * `typeof 5 === "number"` never equals the declared string `"integer"`.
 */
function matchesDeclaredType(value: unknown, declared: string): boolean {
  if (declared === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }
  return jsonTypeOf(value) === declared;
}

/**
 * Re-type a single string argument to the type its schema declares. Returns
 * `undefined` when the string can't be read as that type, so the caller leaves
 * the original value alone and the upstream rejection stands.
 */
function coerceString(raw: string, declared: string): unknown {
  if (declared === "object" || declared === "array") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    return jsonTypeOf(parsed) === declared ? parsed : undefined;
  }
  if (declared === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return undefined;
  }
  if (declared === "number" || declared === "integer") {
    if (raw.trim() === "") return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) return undefined;
    if (declared === "integer" && !Number.isInteger(n)) return undefined;
    return n;
  }
  return undefined;
}

/**
 * Models routinely send a JSON *string* where the schema declares an object or
 * array (`patch: "{\"sections\":[…]}"`) and `"true"` where it declares a
 * boolean. The upstream server rejects the call before executing it and the
 * agent burns steps retrying the same shape.
 *
 * Returns a copy with those arguments re-typed, or `null` when nothing could be
 * coerced. Only string values whose declared type is object/array/boolean/
 * number/integer are touched — a `string`-typed parameter is never reinterpreted,
 * and an unparseable value is left as sent.
 */
export function coerceArgsToSchema(
  schema: ToolInputSchema | undefined,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!schema?.properties || !args) return null;

  let changed = false;
  const out: Record<string, unknown> = { ...args };
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") continue;
    const declared = schema.properties[key]?.type;
    if (!declared || declared === "string") continue;
    const coerced = coerceString(value, declared);
    if (coerced === undefined) continue;
    out[key] = coerced;
    changed = true;
  }
  return changed ? out : null;
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

  // A present-but-wrong-typed argument is the common failure when nothing is
  // missing — say so, otherwise the hint reads as "everything is fine".
  const mistyped = sent
    .filter((k) => {
      const declared = schema?.properties?.[k]?.type;
      return declared != null && !matchesDeclaredType(args?.[k], declared);
    })
    .map(
      (k) =>
        `${k} (expected ${schema?.properties?.[k]?.type}, got ${jsonTypeOf(args?.[k])})`,
    );

  const parts = [
    `Invalid arguments for "${toolName}".`,
    required.length ? `Required: ${required.map(describe).join(", ")}.` : "",
    `You sent: ${sent.length ? sent.join(", ") : "(none)"}.`,
    missing.length ? `Missing required: ${missing.join(", ")}.` : "",
    mistyped.length ? `Wrong type: ${mistyped.join(", ")}.` : "",
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

interface ToolResultLike {
  isError?: boolean;
  content?: Array<{ type?: string; text?: string }>;
}

/**
 * The error text of a `tools/call` result that failed argument validation, or
 * `null` for anything else — including an `isError` result from a tool that ran
 * and failed on its own terms, which must not be retried.
 */
export function invalidParamsResultText(result: unknown): string | null {
  const r = result as ToolResultLike | null;
  if (!r || r.isError !== true || !Array.isArray(r.content)) return null;
  const text = r.content
    .map((c) => (c?.type === "text" ? c.text : null))
    .filter((t): t is string => typeof t === "string")
    .join("\n");
  return /MCP error -32602|Input validation error/.test(text) ? text : null;
}

/** Copy of an errored `tools/call` result with the hint appended to its text. */
export function appendHintToResult<T>(result: T, hint: string): T {
  const r = result as ToolResultLike;
  return {
    ...r,
    content: (r.content ?? []).map((c, i) =>
      i === 0 && c?.type === "text"
        ? { ...c, text: `${c.text}\n\n${hint}` }
        : c,
    ),
  } as T;
}
