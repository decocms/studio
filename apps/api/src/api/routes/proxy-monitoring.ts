import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function extractCallToolErrorMessage(
  result: CallToolResult,
): string | undefined {
  // A non-conformant downstream MCP server can send a null/missing result.
  if (!result || typeof result !== "object" || !result.isError) {
    return undefined;
  }
  const content = (result as unknown as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      (item as { type?: unknown }).type === "text" &&
      "text" in item &&
      typeof (item as { text?: unknown }).text === "string"
    ) {
      return (item as { text: string }).text;
    }
  }

  return undefined;
}

/**
 * Extract custom properties from tool call arguments (_meta.properties).
 * Only string values are accepted to match the properties schema.
 */
export function extractMetaProperties(
  args: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!args) return undefined;

  const meta = args._meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta))
    return undefined;

  const properties = (meta as Record<string, unknown>).properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return undefined;

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Merge properties from header (ctx.metadata.properties) and _meta.properties.
 * Header properties take precedence over _meta properties.
 */
export function mergeProperties(
  headerProps: Record<string, string> | undefined,
  metaProps: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headerProps && !metaProps) return undefined;
  if (!headerProps) return metaProps;
  if (!metaProps) return headerProps;

  // Header takes precedence
  return { ...metaProps, ...headerProps };
}
