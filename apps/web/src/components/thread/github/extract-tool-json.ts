/**
 * Normalizes the two shapes github-mcp-server returns tool results in:
 *   - `structuredContent: T` (parsed JSON, preferred)
 *   - `content: [{ type: "text", text: "<stringified JSON>" }]` (fallback)
 *
 * github-mcp-server often returns only `content` text (structuredContent is
 * null). Some proxies attach an empty `{}` structuredContent — in that case
 * we still read the text payload.
 */
type ToolResultLike = {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
};

/**
 * Returns the error text of a tool result flagged `isError`, or null when the
 * call succeeded. github-mcp-server signals failures (bad token scope,
 * unsupported method, GitHub API errors) via `isError: true` with the message
 * in the text content — NOT by rejecting the call.
 */
export function toolErrorMessage(r: unknown): string | null {
  if (!r || typeof r !== "object") return null;
  const result = r as ToolResultLike;
  if (!result.isError) return null;
  const text = result.content?.find((c) => c.type === "text")?.text?.trim();
  return text || "GitHub MCP tool returned an error";
}

/**
 * Throws when a tool result is flagged `isError`. Call at the top of a query
 * `select` so a swallowed tool failure surfaces as the query's error state
 * instead of being silently mapped to an empty/`null` payload.
 */
export function assertToolOk(r: unknown): void {
  const message = toolErrorMessage(r);
  if (message) throw new Error(message);
}

function parseTextJson(text: string): unknown | null {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function payloadFromToolResult(r: unknown): unknown | null {
  if (!r || typeof r !== "object") return null;
  const result = r as ToolResultLike;
  const textPart = result.content?.find((c) => c.type === "text")?.text;
  const fromText = textPart ? parseTextJson(textPart) : null;

  const sc = result.structuredContent;
  if (sc === undefined || sc === null) return fromText;

  if (
    typeof sc === "object" &&
    !Array.isArray(sc) &&
    Object.keys(sc).length === 0
  ) {
    return fromText ?? sc;
  }

  return sc;
}

export function extractToolJson<T>(r: unknown): T | null {
  const parsed = payloadFromToolResult(r);
  return parsed === null ? null : (parsed as T);
}

/** Pull request number from a GitHub PR URL, if present. */
export function pullNumberFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  const match = url.match(/\/pull\/(\d+)\b/);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Plain-text tool payloads that embed a PR link. */
export function pullRequestFromToolText(r: unknown): {
  number: number;
  htmlUrl: string;
} | null {
  if (!r || typeof r !== "object") return null;
  const text = (r as ToolResultLike).content?.find(
    (c) => c.type === "text",
  )?.text;
  if (!text) return null;
  const htmlUrl = text.match(/https:\/\/github\.com\/[^\s"]+\/pull\/\d+/)?.[0];
  const number = pullNumberFromUrl(htmlUrl);
  if (!number || !htmlUrl) return null;
  return { number, htmlUrl };
}
