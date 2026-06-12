import { nanoid } from "nanoid";

/** Message ID generator. Use as a closure where a `() => string` is
 *  expected (e.g. toUIMessageStreamResponse). Portable harness leaf — does
 *  not reach the cluster `@/shared/utils/generate-id`. */
export const generateMessageId = () => `msg_${nanoid()}`;

export const DEFAULT_MAX_TOKENS = 32768;

/**
 * Clamp the per-request output budget so input + output fits the context
 * window. Some providers (e.g. OpenRouter) report `max_completion_tokens` ≈
 * `context_length`; passing it raw overflows the window once any prompt is
 * added and the provider rejects the whole request. Reserves 2x the input
 * estimate because token estimation is rough (tool schemas especially) —
 * over-reserving output is harmless, undercounting input re-triggers overflow.
 */
export function resolveMaxOutputTokens(
  limits: { contextWindow?: number; maxOutputTokens?: number } | undefined,
  inputTokensEstimate: number,
): number {
  const modelMax = limits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const contextWindow = limits?.contextWindow;
  if (!contextWindow) return modelMax;
  const available = contextWindow - inputTokensEstimate * 2;
  return Math.max(1024, Math.min(modelMax, available));
}

/** Per-MCP-tool-call timeout. Portable mirror of `@/core/constants`'
 *  `MCP_TOOL_CALL_TIMEOUT_MS` (5 minutes). Lives here so the portable
 *  tool-assembly leaves don't reach the cluster constants module. */
export const MCP_TOOL_CALL_TIMEOUT_MS = 5 * 60 * 1000;
