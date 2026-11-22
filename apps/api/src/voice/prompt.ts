import type { UIMessage } from "ai";
import { TEXT_MODE_PROMPT, voiceModePrompt } from "@decocms/shared/voice";

/** Claude Code restores its original system prompt on resume, so style is per-message. */
export function withVoiceResponseStyle<T extends UIMessage>(
  message: T,
  voiceMode: boolean,
  harnessId: string | null,
  voiceContext?: string,
): T {
  return {
    ...message,
    parts: [
      ...message.parts,
      {
        type: "text",
        text: voiceMode ? voiceModePrompt(harnessId) : TEXT_MODE_PROMPT,
      },
      ...(voiceContext ? [{ type: "text" as const, text: voiceContext }] : []),
    ],
  };
}
