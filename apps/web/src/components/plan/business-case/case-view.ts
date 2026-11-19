/**
 * What the case tab shows. A case is only shown as a canvas once it is ready:
 * while its chat is still building it, the person sees the question the agent
 * is waiting on, or the cards filling in. A chat that stopped before the case
 * was ready shows the canvas, so the case is never stuck behind a wait.
 */

import {
  BUSINESS_CASE_CARD_KEYS,
  type BusinessCase,
} from "@decocms/shared/business-case";
import type { ChatMessage, UserAskToolPart } from "@/components/chat/types";
import type { ScreenQuestion } from "../guide/guide-screens.tsx";

export type CaseView =
  | { kind: "question"; part: UserAskToolPart }
  | { kind: "building"; filled: number }
  | { kind: "canvas" };

export function caseView(input: {
  value: BusinessCase;
  /** Whether the open chat is this case's chat. */
  isCaseThread: boolean;
  messages: ChatMessage[];
  /** The chat's agent is still working, or about to. */
  running: boolean;
}): CaseView {
  const { value, messages } = input;
  if (value.status === "ready" || !input.isCaseThread)
    return { kind: "canvas" };
  const part = pendingUserAsk(messages);
  if (part) return { kind: "question", part };
  // No message yet: the chat was just created and its first turn is on the way.
  if (!input.running && messages.length > 0) return { kind: "canvas" };
  const filled = BUSINESS_CASE_CARD_KEYS.filter(
    (key) => value.cards[key].state === "filled",
  ).length;
  return { kind: "building", filled };
}

/** The first question of the last turn the person has not answered yet. */
function pendingUserAsk(messages: ChatMessage[]): UserAskToolPart | null {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  for (const part of last.parts) {
    if (part.type === "tool-user_ask" && part.state === "input-available") {
      return part;
    }
  }
  return null;
}

/** A `user_ask` as the question screen draws it: its options for a choice,
 *  yes and no for a confirm, none for free text. */
export function userAskQuestion(
  part: UserAskToolPart,
  labels: { yes: string; no: string },
): ScreenQuestion {
  const input = part.input;
  const options =
    input?.type === "choice"
      ? [
          ...new Set(
            (input.options ?? []).flatMap((o) => (o?.trim() ? [o.trim()] : [])),
          ),
        ]
      : input?.type === "confirm"
        ? [labels.yes, labels.no]
        : [];
  return { text: input?.prompt ?? "", options };
}
