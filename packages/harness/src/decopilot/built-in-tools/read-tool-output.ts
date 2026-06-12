import { tool, zodSchema } from "ai";
import { z } from "zod";

export interface ReadToolOutputParams {
  readonly toolOutputMap: Map<string, string>;
}

export function createReadToolOutputTool(params: ReadToolOutputParams) {
  const { toolOutputMap } = params;
  return tool({
    description:
      "Filter a tool output that was too large to display inline. " +
      "Returns all lines matching the given regular expression pattern (grep-like). " +
      "You may call this tool multiple times with different patterns to extract different pieces of information.",
    inputExamples: [
      {
        input: { tool_call_id: "id_1", pattern: "error|warning" },
      },
      {
        input: {
          tool_call_id: "id_2",
          pattern: '"status":\\s*"failed"',
        },
      },
    ],
    inputSchema: zodSchema(
      z.object({
        tool_call_id: z.string(),
        pattern: z
          .string()
          .min(1)
          .describe(
            "Regular expression pattern to filter tool output lines. Returns all matching lines.",
          ),
      }),
    ),
    execute: async ({ tool_call_id, pattern }) => {
      if (!toolOutputMap.has(tool_call_id)) {
        return {
          result: `Tool output not found for tool call id: ${tool_call_id}. Available ids: ${[...toolOutputMap.keys()].join(", ") || "(none)"}`,
          matchCount: 0,
          totalLines: 0,
        };
      }
      const input = toolOutputMap.get(tool_call_id)!;

      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        return {
          result: `Invalid regex pattern: ${pattern}`,
          matchCount: 0,
          totalLines: 0,
        };
      }

      const lines = input.split("\n");
      const matching = lines.filter((line) => regex.test(line));
      const result = matching.join("\n");

      const tokenCount = estimateJsonTokens(result);
      if (tokenCount > MAX_RESULT_TOKENS) {
        const preview = createOutputPreview(result);
        return {
          result: `Output is still too long (${tokenCount} tokens), use a more specific pattern to reduce output.\n\nPreview:\n${preview}`,
          matchCount: matching.length,
          totalLines: lines.length,
        };
      }

      return {
        result,
        matchCount: matching.length,
        totalLines: lines.length,
      };
    },
  });
}
/** Maximum tokens for the full result returned to the model */
export const MAX_RESULT_TOKENS = 32_000;

const MAX_PREVIEW_TOKENS = 400;

/**
 * Create a head+tail preview of a large text output.
 * Adaptively trims lines so the preview stays under MAX_PREVIEW_TOKENS (~120 tokens),
 * keeping it compact enough that the surrounding message fits well within 4000 tokens.
 */
export function createOutputPreview(
  text: string,
  maxLines = 20,
  tailLines = 5,
): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines + tailLines) {
    if (estimateTokens(text) <= MAX_PREVIEW_TOKENS) return text;
  }

  let headCount = Math.min(maxLines, lines.length);
  const tailCount = Math.min(tailLines, lines.length);

  while (headCount > 1) {
    const head = lines.slice(0, headCount);
    const tail = lines.slice(-tailCount);
    const omitted = lines.length - headCount - tailCount;
    const separator = `\n--- truncated (${omitted} more lines) ---\n`;
    const candidate = [...head, separator, ...tail].join("\n");

    if (estimateTokens(candidate) <= MAX_PREVIEW_TOKENS) return candidate;
    headCount = Math.floor(headCount * 0.6);
  }

  // Fallback: character-truncate to fit the budget
  const maxChars = MAX_PREVIEW_TOKENS * 4;
  return text.slice(0, maxChars) + "\n--- truncated ---";
}

/**
 * Lightweight Token Estimator
 *
 * Estimates token counts using character-based heuristics.
 * No external dependencies — ~90-95% accurate for English text, JSON, and code.
 *
 * Inspired by tokenx (github.com/johannschopplich/tokenx).
 *
 * Rule of thumb for common tokenizers (cl100k_base, o200k_base):
 *  - ~4 characters per token for English/JSON/code
 *  - CJK characters tend to be ~1.5 tokens each
 */

const CHARS_PER_TOKEN = 4;

const CJK_REGEX =
  /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

/**
 * Estimate token count for a string.
 */
function estimateTokens(text: string): number {
  if (!text) return 0;

  const cjkCount = text.match(CJK_REGEX)?.length ?? 0;
  const nonCjkLength = text.length - cjkCount;

  // CJK characters ≈ 1.5 tokens each
  return Math.ceil(nonCjkLength / CHARS_PER_TOKEN) + Math.ceil(cjkCount * 1.5);
}

/**
 * Estimate token count for an arbitrary value (serializes to JSON if needed).
 */
export function estimateJsonTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return estimateTokens(text);
}
