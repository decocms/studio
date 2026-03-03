export function unwrapToolResult<T>(result: unknown): T {
  const topLevel = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ text?: string }>;
  } | null;

  if (topLevel?.isError) {
    throw new Error(topLevel.content?.[0]?.text ?? "Tool call failed");
  }

  const payload = topLevel?.structuredContent ?? result;
  const maybeError = payload as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  } | null;
  if (maybeError?.isError) {
    throw new Error(maybeError.content?.[0]?.text ?? "Tool call failed");
  }
  return payload as T;
}
