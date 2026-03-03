export function unwrapToolResult<T>(result: unknown): T {
  const payload =
    (result as { structuredContent?: unknown }).structuredContent ?? result;
  const maybeError = payload as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  } | null;
  if (maybeError?.isError) {
    throw new Error(maybeError.content?.[0]?.text ?? "Tool call failed");
  }
  return payload as T;
}
