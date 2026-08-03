export const DEFAULT_MAX_TOKENS = 32768;

/**
 * The tools whose schemas actually reach the provider. `prepareStep` narrows
 * each request to `activeTools`, so an agent behind enable_tool gating can hold
 * hundreds of assembled tools while sending a couple dozen. Sizing the input
 * estimate off the full set inflates it several-fold, and since the estimate is
 * doubled below, that pins the output budget to the 1024 floor and truncates
 * every single response (`finishReason: "length"`).
 */
export function selectActiveTools<T extends Record<string, unknown>>(
  tools: T,
  activeToolNames: string[] | undefined,
): Record<string, unknown> {
  if (!activeToolNames) return tools;
  const active = new Set(activeToolNames);
  return Object.fromEntries(
    Object.entries(tools).filter(([name]) => active.has(name)),
  );
}

/**
 * Clamp the per-request output budget so input + output fits the context
 * window. Some providers (e.g. OpenRouter) report `max_completion_tokens` ≈
 * `context_length`; passing it raw overflows the window once any prompt is
 * added and the provider rejects the whole request. Reserves 2x the input
 * estimate because token estimation is rough (tool schemas especially) —
 * over-reserving output is harmless, undercounting input re-triggers overflow.
 *
 * Feed this an estimate over `selectActiveTools`, not the whole assembled set.
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
