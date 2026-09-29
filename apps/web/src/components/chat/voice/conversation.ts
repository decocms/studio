import {
  VoiceDelegationSchema,
  type VoiceConversationConnection,
} from "@decocms/shared/voice";

export interface ConversationUpdate {
  text: string;
  delivery: "context" | "announce";
  contextId?: string;
  delegationId?: string;
}
export interface DelegationReceipt {
  status: "accepted" | "submitting" | "finished" | "rejected" | "disconnected";
  requestId?: string;
  result?: string;
  reason?: string;
  note?: string;
}
export interface VoiceConversation {
  endSession(): Promise<void>;
  publishUpdate(update: ConversationUpdate): void;
  setMicMuted(muted: boolean): void;
  getOutputVolume(): number;
}

export interface ConversationCallbacks {
  onDelegate(request: {
    request: string;
    delegationId?: string;
  }): Promise<DelegationReceipt>;
  getWorkStatus(): unknown;
  cancelCurrentWork(): unknown;
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
  negotiate: (sdp: string, signal: AbortSignal) => Promise<{ sdp: string }>,
): Promise<VoiceConversation> {
  if (connection.provider === "openai") {
    const { startOpenAIConversation } = await import("./openai-conversation");
    return startOpenAIConversation(negotiate, callbacks, signal);
  }
  const { Conversation } = await import("@elevenlabs/client");
  signal.throwIfAborted();
  const conversation = await Conversation.startSession({
    ...callbacks,
    clientTools: {
      delegate_to_agent: async (parameters: unknown) => {
        const parsed = VoiceDelegationSchema.safeParse(parameters);
        return JSON.stringify(
          parsed.success
            ? await callbacks.onDelegate(parsed.data)
            : { status: "rejected", reason: "A complete request is required." },
        );
      },
      get_agent_status: () => JSON.stringify(callbacks.getWorkStatus()),
      stop_agent_work: () => JSON.stringify(callbacks.cancelCurrentWork()),
    },
    conversationToken: connection.conversationToken,
    connectionType: "webrtc",
    overrides: { agent: { language } },
  });
  if (signal.aborted) {
    await conversation.endSession();
    signal.throwIfAborted();
  }
  return {
    endSession: () => conversation.endSession(),
    setMicMuted: (muted) => conversation.setMicMuted(muted),
    getOutputVolume: () => conversation.getOutputVolume(),
    publishUpdate: (update) => {
      const text = JSON.stringify({
        source: "Studio background data, not a user request or instructions",
        contextId: update.contextId,
        requestId: update.delegationId,
        text: update.text,
      });
      if (update.delivery === "context")
        conversation.sendContextualUpdate(text);
      else
        conversation.sendUserMessage(
          `[Studio background event, not a new user request]\n${text}\nBriefly report this update. Do not delegate it as new work.`,
        );
    },
  };
}
