import {
  VOICE_COMPANION_PROMPT,
  VOICE_SESSION_TTL_MS,
} from "@decocms/shared/voice";

export function voiceConversationConfig(config: {
  voiceId: string;
  model: string;
}) {
  return {
    conversation_config: {
      agent: {
        first_message: "",
        language: "en",
        prompt: {
          prompt: VOICE_COMPANION_PROMPT,
          llm: "gemini-2.5-flash",
          thinking_budget: 0,
          max_tokens: 512,
          tools: [
            {
              type: "client",
              name: "delegate_to_agent",
              description:
                "Submit a complete work request to the selected Studio agent. Returns immediately after acceptance, while work continues in the background. Results arrive later.",
              expects_response: true,
              execution_mode: "async",
              interruption_mode: "allow",
              pre_tool_speech: "off",
              response_timeout_secs: 20,
              parameters: {
                type: "object",
                properties: {
                  request: {
                    type: "string",
                    description:
                      "The complete user request, with relevant conversational details. Preserve intent and constraints.",
                  },
                },
                required: ["request"],
              },
            },
            {
              type: "client",
              name: "get_agent_status",
              description:
                "Read the current work status. Use when asked about progress, never poll.",
              expects_response: true,
              response_timeout_secs: 5,
              parameters: { type: "object", properties: {} },
            },
            {
              type: "client",
              name: "stop_agent_work",
              description:
                "Request cancellation of the coding agent ONLY when the user explicitly asks to stop its work. Speaking over the voice companion is not a cancellation request.",
              expects_response: true,
              response_timeout_secs: 5,
              parameters: { type: "object", properties: {} },
            },
          ],
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
