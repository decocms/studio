import { z } from "zod";

export const VOICE_SESSION_TTL_MS = 10 * 60 * 1000;
export const VOICE_MAX_TEXT_LENGTH = 12_000;

export const VoiceSessionSchema = z.object({
  token: z.string(),
  transcriptionToken: z.string(),
  expiresAt: z.number(),
});

export const VoiceSpeechSchema = z.object({
  token: z.string().min(1).max(4096),
  text: z.string().trim().min(1).max(VOICE_MAX_TEXT_LENGTH),
});

export const VOICE_MODE_PROMPT = `This turn is a spoken conversation. Use the same tools and perform the requested work normally. Keep the final user-facing text brief, usually one or two sentences, in the user's language. Write naturally for reading aloud. Avoid markdown, code blocks, lists, URLs, and reading implementation details aloud unless the user asks. State what actually happened; do not claim success before tools confirm it. Ask a short question when clarification or approval is required. These style instructions apply to this turn only.`;

export const TEXT_MODE_PROMPT = `This turn is a text chat. Use the agent's normal response style. Voice-only style instructions from earlier turns no longer apply.`;
