import { tool, zodSchema } from "ai";
import { z } from "zod";
import { runTransform } from "@/sandbox";

export interface ReadToolOutputParams {
  readonly toolOutputMap: Map<string, string>;
}

export function createReadToolOutputTool(params: ReadToolOutputParams) {
  const { toolOutputMap } = params;
  return tool({
    description:
      "The input is a string. Dont make assumptions about its format; prefer using regexes and string manipulation to extract the desired information. You may call this tool multiple times to extract the desired information.",
    inputExamples: [
      {
        input: {
          tool_call_id: "tool_call_id_1",
          code: "export default (input) => { return input.match(/[a-z]/g); }",
        },
      },
      {
        input: {
          tool_call_id: "tool_call_id_2",
          code: "export default (input) => { return input.split(' ').map(word => word.length); }",
        },
      },
    ],
    inputSchema: zodSchema(
      z.object({
        tool_call_id: z.string(),
        code: z
          .string()
          .min(1)
          .describe(
            "JavaScript code to transform the tool output. The code must be an ES module: `export default (input) => { ... }`",
          ),
      }),
    ),
    execute: async ({ tool_call_id, code }) => {
      if (!toolOutputMap.has(tool_call_id)) {
        throw new Error(
          `Tool output not found for tool call id: ${tool_call_id}`,
        );
      }
      const input = toolOutputMap.get(tool_call_id)!;

      const result = await runTransform({
        input,
        code,
        timeoutMs: 5_000,
      });

      const tokenCount = estimateJsonTokens({ return: result.returnValue });
      if (tokenCount > 4000) {
        throw new Error(
          `Tool call ${tool_call_id} output is too long to display (${tokenCount} tokens), reduce or truncate the output`,
        );
      }

      return {
        result: result.returnValue as string,
        error: result.error,
        consoleLogs: result.consoleLogs,
      };
    },
  });
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
