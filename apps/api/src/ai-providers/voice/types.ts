import type { VoiceConversationConnection } from "@decocms/shared/voice";

/** Legacy transcription/synthesis for browsers opened before realtime rollout. */
export interface SpeechAdapter {
  createTranscriptionToken(): Promise<string>;
  synthesize(text: string, signal: AbortSignal): Promise<Response>;
}

/** Providers own speech; Studio owns work, permissions, and history. */
export interface ConversationAdapter {
  createSession(input: {
    language: "en" | "pt";
    safetyIdentifier: string;
  }): Promise<VoiceConversationConnection>;
}
