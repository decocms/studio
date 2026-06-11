import {
  MAX_RESULT_TOKENS,
  createOutputPreview,
  estimateJsonTokens,
} from "../read-tool-output";

/**
 * Oversized results are stashed in `toolOutputMap` and returned as a preview
 * pointer; the LLM extracts via `read_tool_output`.
 */
export function maybeTruncate(
  result: unknown,
  toolOutputMap: Map<string, string>,
): unknown {
  let serialized: string;
  try {
    serialized =
      typeof result === "string" ? result : JSON.stringify(result, null, 2);
  } catch {
    serialized = String(result);
  }
  const tokenCount = estimateJsonTokens(serialized);
  if (tokenCount > MAX_RESULT_TOKENS) {
    const toolCallId = `vm_${Date.now()}`;
    toolOutputMap.set(toolCallId, serialized);
    const preview = createOutputPreview(serialized);
    return {
      truncated: true,
      message: `Output too large (${tokenCount} tokens). Use read_tool_output with tool_call_id "${toolCallId}" to extract specific data.`,
      preview,
    };
  }
  return result;
}
