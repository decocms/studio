/**
 * Prior conversation for the first claude-code turn on a thread that ran on
 * Decopilot. That turn has no Claude Code session to resume, and the dispatch
 * wire carries one user message and no history, so the history rides on the
 * prompt instead.
 */

import { estimateJsonTokens } from "@/harnesses/lib/decopilot/built-in-tools/read-tool-output";

/** ~32k characters: enough for the recent thread, small next to any context window. */
const HISTORY_PREFIX_TOKEN_BUDGET = 8_000;

interface HistoryMessage {
  role: string;
  parts: readonly unknown[];
}

function textOf(message: HistoryMessage): string {
  return message.parts
    .flatMap((part) => {
      const typed = part as { type?: unknown; text?: unknown } | null;
      return typed?.type === "text" && typeof typed.text === "string"
        ? [typed.text]
        : [];
    })
    .join("\n")
    .trim();
}

/**
 * Text-only transcript of `messages` (chronological), keeping the newest turns
 * that fit `budgetTokens`. An oversized newest turn keeps its end. `null` when
 * there is no user/assistant text at all.
 */
export function buildHistoryPrefix(
  messages: readonly HistoryMessage[],
  budgetTokens: number = HISTORY_PREFIX_TOKEN_BUDGET,
): string | null {
  const kept: string[] = [];
  let remaining = budgetTokens;
  for (const message of [...messages].reverse()) {
    if (remaining <= 0) break;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = textOf(message);
    if (!text) continue;
    const label = message.role === "user" ? "User" : "Assistant";
    let entry = `${label}: ${text}`;
    let cost = estimateJsonTokens(entry);
    if (cost > remaining) {
      if (kept.length > 0) break;
      entry = `${label}: …${text.slice(-remaining * 4)}`;
      cost = remaining;
    }
    kept.push(entry);
    remaining -= cost;
  }
  if (kept.length === 0) return null;
  return [
    "<prior_conversation>",
    "Earlier turns of this chat, from before it moved to this runtime. Use them as context; the user's new message follows.",
    "",
    kept.reverse().join("\n\n"),
    "</prior_conversation>",
  ].join("\n");
}
