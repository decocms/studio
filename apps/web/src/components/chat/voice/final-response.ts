import { VOICE_MAX_TEXT_LENGTH } from "@decocms/shared/voice";
import type { ChatMessage } from "../types";
import { turnMessages } from "./work-status";

/** Only the final text part belonging to this user turn may be spoken. */
export function finalVoiceResponse(
  messages: ChatMessage[],
  userMessageId: string,
): string | null {
  const turn = turnMessages(messages, userMessageId);
  if (!turn) return null;
  const last = turn.at(-1);
  if (
    !last ||
    last.parts.some(
      (part) =>
        "state" in part &&
        ["approval-requested", "input-streaming", "input-available"].includes(
          String(part.state),
        ),
    )
  )
    return null;
  // Tool commentary can precede later tool parts. It is not the answer.
  const part = last.parts.findLast(
    (part) =>
      part.type === "text" ||
      part.type === "dynamic-tool" ||
      part.type.startsWith("tool-"),
  );
  if (part?.type !== "text") return "";
  if (part.state === "streaming") return null;
  const text = part.text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/[*_`]/g, "")
    .trim();
  if (!text) return "";
  if (text.length <= VOICE_MAX_TEXT_LENGTH) return text;
  const prefix = text.slice(0, VOICE_MAX_TEXT_LENGTH - 1);
  return `${prefix.slice(0, prefix.lastIndexOf(" "))}…`;
}
