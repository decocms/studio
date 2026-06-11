/**
 * Decopilot chat mode — orthogonal to tool approval level.
 * Maps mode to system prompts and first-step tool forcing.
 */

export const CHAT_MODES = [
  "default",
  "plan",
  "web-search",
  "gen-image",
] as const;

export type ChatMode = (typeof CHAT_MODES)[number];

export interface ResolvedModeConfig {
  /** When true, use plan-mode hard-block + propose_plan + enable_tool gating */
  isPlanMode: boolean;
  /** First step only — forces this tool name when present in the tool set */
  forcedFirstStepTool: "web_search" | "generate_image" | null;
  /** Injected when mode is plan */
  planPrompt: string | null;
  /**
   * When mode is web-search and web_search is registered — behavior hint for the model.
   * Omitted for other modes even if the tool exists.
   */
  webSearchInstructionPrompt: string | null;
}

function buildPlanPrompt(isCliAgent: boolean): string {
  return (
    "<plan-mode>\n" +
    "You are in plan mode.\n\n" +
    (isCliAgent
      ? ""
      : "CRITICAL: your final output MUST be a single call to `propose_plan`. " +
        "Do NOT write the plan as chat text — call the tool instead. " +
        "Describing the plan in chat without calling `propose_plan` is an error.\n\n") +
    "Your goal: produce a plan so complete that a fresh thread, with no memory of " +
    "this conversation, can execute it without asking follow-up questions.\n\n" +
    "Clarifications: if the request is ambiguous, you may call `user_ask` AT MOST ONCE " +
    "with a single, focused question. Do not ask multiple questions in sequence. " +
    "If you can make a reasonable assumption, do so and note it in the plan instead of asking.\n\n" +
    "Plan quality bar: include concrete details, ordered steps, risks, trade-offs, " +
    "and alternatives you considered. Write for a reader with no prior context.\n" +
    "</plan-mode>"
  );
}

const WEB_SEARCH_INSTRUCTION_PROMPT =
  "<web-search>\n" +
  "The web_search tool streams its research result directly to the user in real time. " +
  "After a search completes, do NOT repeat, summarize, or restate the research content — " +
  "the user can already see it. Simply confirm the search succeeded and highlight key " +
  "takeaways in one or two sentences. Only elaborate if the user explicitly asks.\n\n" +
  "For large results, the tool result contains a `uri` (mesh-storage:…) instead of " +
  "inline content. To re-access the full research in a later turn, call " +
  "`read_resource` with that URI.\n" +
  "</web-search>";

/**
 * Resolve active prompt fragments and tool forcing from chat mode.
 */
export function resolveModeConfig(
  mode: ChatMode,
  options: { isCliAgent: boolean },
): ResolvedModeConfig {
  const isPlanMode = mode === "plan";

  const forcedFirstStepTool =
    mode === "web-search"
      ? "web_search"
      : mode === "gen-image"
        ? "generate_image"
        : null;

  const planPrompt =
    mode === "plan" ? buildPlanPrompt(options.isCliAgent) : null;

  const webSearchInstructionPrompt =
    mode === "web-search" ? WEB_SEARCH_INSTRUCTION_PROMPT : null;

  return {
    isPlanMode,
    forcedFirstStepTool,
    planPrompt,
    webSearchInstructionPrompt,
  };
}
