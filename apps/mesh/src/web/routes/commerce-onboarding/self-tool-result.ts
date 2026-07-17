interface SelfToolResult {
  structuredContent?: unknown;
  isError?: boolean;
  content?: Array<{ text?: string }>;
}

function getToolErrorMessage(result: SelfToolResult): string {
  return (
    result.content?.find((item) => item.text)?.text ??
    "A configuração do Commerce Discovery falhou."
  );
}

/**
 * Unwrap a self-MCP tool result: throw the friendly message on error, otherwise
 * return the structured payload. Shared by the onboarding setup screen and the
 * commerce-connect modal so both read tool results the same way.
 */
export function parseSelfToolResult<T>(result: unknown): T {
  const toolResult = result as SelfToolResult;
  if (toolResult.isError) {
    throw new Error(getToolErrorMessage(toolResult));
  }
  return (toolResult.structuredContent ?? result) as T;
}
