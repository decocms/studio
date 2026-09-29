/** Speech providers handle audio; Studio owns the agent and conversation. */
export interface SpeechAdapter {
  createTranscriptionToken(): Promise<string>;
  synthesize(text: string, signal: AbortSignal): Promise<Response>;
}
