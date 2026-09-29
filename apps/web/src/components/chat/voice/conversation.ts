import type { VoiceConversationConnection } from "@decocms/shared/voice";

export interface VoiceConversation {
  endSession(): Promise<void>;
  sendContextualUpdate(text: string, options?: { contextId: string }): void;
  sendUserMessage(text: string): void;
  setMicMuted(muted: boolean): void;
  getOutputVolume(): number;
}

export interface ConversationCallbacks {
  clientTools: Record<
    string,
    (parameters: unknown) => string | Promise<string>
  >;
  onConnect(): void;
  onModeChange(event: { mode: "listening" | "speaking" | "working" }): void;
  onMessage(event: {
    role: "user" | "agent";
    message: string;
    event_id?: string | number;
  }): void;
  onVadScore(event: { vadScore: number }): void;
  onUserSpeaking(speaking: boolean): void;
  onError(): void;
  onDisconnect(): void;
}

export async function startVoiceConversation(
  connection: VoiceConversationConnection,
  language: "en" | "pt",
  callbacks: ConversationCallbacks,
  signal: AbortSignal,
): Promise<VoiceConversation> {
  if (connection.provider === "openai") {
    const { startOpenAIConversation } = await import("./openai-conversation");
    return startOpenAIConversation(connection.clientSecret, callbacks, signal);
  }
  const { Conversation } = await import("@elevenlabs/client");
  signal.throwIfAborted();
  const conversation = await Conversation.startSession({
    ...callbacks,
    conversationToken: connection.conversationToken,
    connectionType: "webrtc",
    overrides: { agent: { language } },
  });
  if (signal.aborted) {
    await conversation.endSession();
    signal.throwIfAborted();
  }
  return conversation;
}
