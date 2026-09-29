/** Providers own the spoken conversation; Studio owns work, permissions, and history. */
export interface SpeechAdapter {
  createTranscriptionToken(): Promise<string>;
  synthesize(text: string, signal: AbortSignal): Promise<Response>;
  readonly conversationKey: string;
  ensureConversationAgent(): Promise<string>;
  createConversationToken(agentId: string): Promise<string>;
}
