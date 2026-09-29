import type { UIMessage } from "ai";
import { TEXT_MODE_PROMPT, VOICE_MODE_PROMPT } from "@decocms/shared/voice";

/** Claude Code restores its original system prompt on resume, so style is per-message. */
export function withVoiceResponseStyle<T extends UIMessage>(
  message: T,
  voiceMode: boolean,
): T {
  return {
    ...message,
    parts: [
      ...message.parts,
      { type: "text", text: voiceMode ? VOICE_MODE_PROMPT : TEXT_MODE_PROMPT },
    ],
  };
}
