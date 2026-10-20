import {
  VOICE_COMPANION_PROMPT,
  VOICE_SESSION_TTL_MS,
} from "@decocms/shared/voice";

import { VOICE_CONVERSATION_TOOLS } from "./conversation-tools";

export function voiceConversationConfig(config: {
  voiceId: string;
  model: string;
  conversationModel: string;
}) {
  return {
    conversation_config: {
      agent: {
        first_message: "",
        language: "en",
        prompt: {
          prompt: VOICE_COMPANION_PROMPT,
          llm: config.conversationModel,
          thinking_budget: 0,
          max_tokens: 512,
          tools: VOICE_CONVERSATION_TOOLS.map((tool) => ({
            ...tool,
            type: "client",
            expects_response: true,
            response_timeout_secs: tool.name === "delegate_to_agent" ? 20 : 5,
            ...(tool.name === "delegate_to_agent"
              ? {
                  execution_mode: "async",
                  interruption_mode: "allow",
                  pre_tool_speech: "off",
                }
              : {}),
          })),
        },
      },
      asr: { provider: "scribe_realtime", quality: "high" },
      turn: {
        turn_eagerness: "normal",
        // Silence during a long coding task is not a reason to prompt again.
        turn_timeout: -1,
        silence_end_call_timeout: -1,
      },
      tts: { voice_id: config.voiceId, model_id: config.model },
      conversation: {
        max_duration_seconds: VOICE_SESSION_TTL_MS / 1000,
        client_events: [
          "audio",
          "interruption",
          "user_transcript",
          "agent_response",
          "client_tool_call",
          "vad_score",
        ],
      },
    },
    platform_settings: {
      auth: { enable_auth: true },
      privacy: {
        record_voice: false,
        retention_days: 1,
        delete_audio: true,
        delete_transcript_and_pii: true,
      },
      overrides: {
        conversation_config_override: { agent: { language: true } },
      },
    },
  };
}
