/**
 * History a claude-code turn needs on its prompt. The dispatch wire carries one
 * user message and no history, and the resumed Claude Code session holds only
 * the turns that reached the harness, so what the session lacks rides on the
 * prompt instead: the whole prior conversation on the first turn after a thread
 * moves off Decopilot, and otherwise the messages whose turns never ran.
 */

import { estimateJsonTokens } from "@/harnesses/lib/decopilot/built-in-tools/read-tool-output";

/** ~32k characters: enough for the recent thread, small next to any context window. */
const HISTORY_PREFIX_TOKEN_BUDGET = 8_000;

interface HistoryMessage {
  role: string;
  parts: readonly unknown[];
}

interface ThreadHistoryMessage extends HistoryMessage {
  id: string;
  metadata?: unknown;
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
function transcript(
  messages: readonly HistoryMessage[],
  budgetTokens: number,
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
  return kept.length === 0 ? null : kept.reverse().join("\n\n");
}

export function buildHistoryPrefix(
  messages: readonly HistoryMessage[],
  budgetTokens: number = HISTORY_PREFIX_TOKEN_BUDGET,
): string | null {
  const body = transcript(messages, budgetTokens);
  if (!body) return null;
  return [
    "<prior_conversation>",
    "Earlier turns of this chat, from before it moved to this runtime. Use them as context; the user's new message follows.",
    "",
    body,
    "</prior_conversation>",
  ].join("\n");
}

/** The harness reached `result`, which is where it saves its session. */
function harnessCompleted(message: ThreadHistoryMessage): boolean {
  const metadata = message.metadata;
  return (
    message.role === "assistant" &&
    typeof metadata === "object" &&
    metadata !== null &&
    "usage" in metadata
  );
}

/**
 * The user messages before `requestMessageId` that no harness turn answered: a
 * turn that failed before reaching the harness (a sandbox that never woke), or
 * was cancelled, never entered the Claude Code session, so a resumed session
 * answers the new message without them. `history` is chronological. `null`
 * when every earlier message was answered.
 */
export function buildUnansweredPrefix(
  history: readonly ThreadHistoryMessage[],
  requestMessageId: string,
  budgetTokens: number = HISTORY_PREFIX_TOKEN_BUDGET,
): string | null {
  const end = history.findIndex((m) => m.id === requestMessageId);
  if (end === -1) return null;
  const earlier = history.slice(0, end);
  const start = earlier.findLastIndex(harnessCompleted) + 1;
  const body = transcript(
    earlier.slice(start).filter((m) => m.role === "user"),
    budgetTokens,
  );
  if (!body) return null;
  return [
    "<unanswered_messages>",
    "Earlier messages in this chat that never reached you: the turn that should have answered them failed or was cancelled. Treat them as part of the user's request; the user's new message follows.",
    "",
    body,
    "</unanswered_messages>",
  ].join("\n");
}
