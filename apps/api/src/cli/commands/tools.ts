import { z } from "zod";
import {
  errorMessage,
  readDataArg,
  type RequestIo,
  requireSession,
  type SessionOptions,
  studioFetch,
  writeResponse,
} from "../lib/studio-request";

export interface ToolsOptions extends SessionOptions, RequestIo {
  subcommand?: string;
  /** Tool name for `describe`/`call`, or a search term for `list`. */
  arg?: string;
  org?: string;
  /** Tool arguments for `call`: literal JSON, `@<file>`, or `@-` for stdin. */
  data?: string;
  /**
   * `list` prints the full tool objects instead of one line per tool;
   * `describe` prints the full tool object instead of its signature.
   */
  json?: boolean;
}

const TOOLS_USAGE = `Usage:
  decocms tools list --org <slug> [search] [--json]
  decocms tools describe <name> --org <slug> [--json]
  decocms tools call <name> --org <slug> [-d <json|@file|@->]`;

const ToolListSchema = z.object({
  tools: z.array(
    z.looseObject({
      name: z.string(),
      description: z.string().optional(),
    }),
  ),
});

/**
 * `decocms tools` — list, describe, and call the studio's builtin tools
 * through the REST dispatch at `/api/:org/tools`.
 */
export async function toolsCommand(options: ToolsOptions): Promise<number> {
  const { subcommand, arg, org } = options;
  if (
    !subcommand ||
    !["list", "describe", "call"].includes(subcommand) ||
    (subcommand !== "list" && !arg)
  ) {
    console.error(TOOLS_USAGE);
    return 1;
  }
  if (!org) {
    console.error(
      "Missing --org <slug>. The slug is the first path segment of the studio URL.",
    );
    return 1;
  }

  const session = await requireSession(options);
  if (!session) return 1;

  const base = `/api/${encodeURIComponent(org)}/tools`;

  if (subcommand === "call" && arg) {
    let res: Response;
    try {
      const body = (await readDataArg(options.data, options.readStdin)) ?? {
        bytes: "{}",
        contentType: "application/json",
      };
      res = await studioFetch(session, `${base}/${encodeURIComponent(arg)}`, {
        method: "POST",
        body,
        fetch: options.fetch,
      });
    } catch (err) {
      console.error(errorMessage(err));
      return 1;
    }
    return writeResponse(res, session, options.output);
  }

  const res = await studioFetch(session, base, {
    method: "GET",
    fetch: options.fetch,
  });
  if (!res.ok) return writeResponse(res, session, options.output);
  const parsed = ToolListSchema.safeParse(await res.json());
  if (!parsed.success) {
    console.error("Unexpected response from the tools endpoint.");
    return 1;
  }
  const { tools } = parsed.data;

  if (subcommand === "describe") {
    const tool = tools.find((t) => t.name === arg);
    if (!tool) {
      console.error(
        `Unknown tool: ${arg}. Run \`decocms tools list --org ${org} <search>\`.`,
      );
      return 1;
    }
    console.log(
      options.json ? JSON.stringify(tool, null, 2) : formatToolSignature(tool),
    );
    return 0;
  }

  const term = arg?.toLowerCase();
  const matches = term
    ? [
        ...tools.filter((t) => t.name.toLowerCase().includes(term)),
        ...tools.filter(
          (t) =>
            !t.name.toLowerCase().includes(term) &&
            t.description?.toLowerCase().includes(term),
        ),
      ]
    : tools;
  if (options.json) {
    console.log(JSON.stringify(matches));
    return 0;
  }
  for (const tool of matches) {
    const summary = tool.description?.trim().split("\n")[0] ?? "";
    console.log(summary ? `${tool.name}\t${summary}` : tool.name);
  }
  return 0;
}

type JsonSchema = Record<string, unknown>;

const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const oneLine = (text: string) => text.trim().replace(/\s+/g, " ");

const SHOWN_HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint"];

/**
 * A tool as a few lines: name, summary, the hints that change how to call
 * it, and one line per input field. The full schema stays behind `--json`.
 */
export function formatToolSignature(tool: {
  name: string;
  description?: string;
  [key: string]: unknown;
}): string {
  const summary = tool.description?.trim().split("\n")[0];
  const lines = [summary ? `${tool.name} — ${summary}` : tool.name];

  const { annotations, inputSchema } = tool;
  const hints = isSchema(annotations)
    ? SHOWN_HINTS.filter((hint) => annotations[hint] === true)
    : [];
  if (hints.length > 0) lines.push(`annotations: ${hints.join(", ")}`);

  const properties = isSchema(inputSchema) ? inputSchema.properties : undefined;
  if (isSchema(properties) && Object.keys(properties).length > 0) {
    const required = requiredKeys(inputSchema);
    lines.push("input:");
    for (const [key, field] of Object.entries(properties)) {
      lines.push(`  ${formatField(key, field, required.has(key))}`);
    }
  } else if (
    isSchema(inputSchema) &&
    (inputSchema.anyOf || inputSchema.oneOf || inputSchema.allOf)
  ) {
    lines.push(`input: ${describeType(inputSchema, 0).type}`);
  } else {
    lines.push("input: none");
  }
  return lines.join("\n");
}

function requiredKeys(schema: unknown): Set<string> {
  const required = isSchema(schema) ? schema.required : undefined;
  return new Set(
    Array.isArray(required)
      ? required.filter((key): key is string => typeof key === "string")
      : [],
  );
}

function formatField(key: string, field: unknown, required: boolean): string {
  const { type, nullable } = describeType(field, 0);
  const hasDefault = isSchema(field) && field.default !== undefined;
  // Output-mode JSON Schema lists defaulted fields as required; callers may
  // still omit them.
  let flags = required && !hasDefault ? "required" : "optional";
  if (nullable) flags += "|nullable";
  if (hasDefault) flags += `, default ${JSON.stringify(field.default)}`;
  const description = isSchema(field) ? fieldDescription(field) : undefined;
  return `${key} (${type}, ${flags})${description ? ` — ${oneLine(description)}` : ""}`;
}

function fieldDescription(field: JsonSchema): string | undefined {
  if (typeof field.description === "string") return field.description;
  const branches = field.anyOf ?? field.oneOf;
  if (!Array.isArray(branches)) return undefined;
  for (const branch of branches) {
    if (isSchema(branch) && typeof branch.description === "string") {
      return branch.description;
    }
  }
  return undefined;
}

/**
 * Compact type text for a schema. Objects show their properties at
 * `depth` 0 and collapse to `object` below that, so a signature stays one
 * level deep.
 */
function describeType(
  schema: unknown,
  depth: number,
): { type: string; nullable: boolean } {
  if (!isSchema(schema)) return { type: "any", nullable: false };
  if ("const" in schema) {
    return schema.const === null
      ? { type: "null", nullable: true }
      : { type: JSON.stringify(schema.const), nullable: false };
  }
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter((value) => value !== null);
    return {
      type: values.map((value) => JSON.stringify(value)).join("|"),
      nullable: values.length < schema.enum.length,
    };
  }
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) {
    let nullable = false;
    const types: string[] = [];
    for (const branch of branches) {
      const described = describeType(branch, depth);
      if (described.type === "null") nullable = true;
      else types.push(described.type);
      nullable ||= described.nullable;
    }
    return { type: unique(types).join("|") || "null", nullable };
  }
  if (Array.isArray(schema.allOf)) {
    return {
      type: schema.allOf
        .map((part) => describeType(part, depth).type)
        .join(" & "),
      nullable: false,
    };
  }
  if (typeof schema.$ref === "string") {
    return { type: schema.$ref.split("/").pop() || "object", nullable: false };
  }

  const declared = Array.isArray(schema.type) ? schema.type : [schema.type];
  const nullable = declared.includes("null");
  const types = declared
    .filter(
      (type): type is string => typeof type === "string" && type !== "null",
    )
    .map((type) => describeBaseType(schema, type, depth));
  if (types.length === 0) return { type: nullable ? "null" : "any", nullable };
  return { type: types.join("|"), nullable };
}

function describeBaseType(
  schema: JsonSchema,
  type: string,
  depth: number,
): string {
  if (type === "string" && typeof schema.format === "string") {
    return `string<${schema.format}>`;
  }
  if (type === "array") {
    if (Array.isArray(schema.prefixItems)) {
      const items = schema.prefixItems.map((item) => withNull(item, depth));
      return `[${items.join(", ")}]`;
    }
    const item = withNull(schema.items, depth);
    return isUnion(item) ? `(${item})[]` : `${item}[]`;
  }
  if (type === "object") return describeObject(schema, depth);
  return type;
}

function describeObject(schema: JsonSchema, depth: number): string {
  const { properties, additionalProperties } = schema;
  if (isSchema(properties) && Object.keys(properties).length > 0) {
    if (depth > 0) return "object";
    const required = requiredKeys(schema);
    const entries = Object.entries(properties).map(([key, value]) => {
      const optional =
        !required.has(key) || (isSchema(value) && value.default !== undefined);
      return `${key}${optional ? "?" : ""}: ${withNull(value, depth + 1)}`;
    });
    return `{ ${entries.join(", ")} }`;
  }
  if (
    isSchema(additionalProperties) &&
    Object.keys(additionalProperties).length > 0
  ) {
    return `{ [key]: ${withNull(additionalProperties, depth + 1)} }`;
  }
  return "object";
}

function withNull(schema: unknown, depth: number): string {
  const { type, nullable } = describeType(schema, depth);
  return nullable && type !== "null" ? `${type}|null` : type;
}

const unique = (values: string[]) => [...new Set(values)];

/** Whether `type` has a `|` outside any `{ }`, `[ ]`, `( )` or string literal. */
function isUnion(type: string): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const char of type) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if ("{[(".includes(char)) depth++;
    else if ("}])".includes(char)) depth--;
    else if (char === "|" && depth === 0) return true;
  }
  return false;
}
