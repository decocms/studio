import { z } from "zod";
import { VOICE_COMPANION_PROMPT } from "@decocms/shared/voice";
import type { ConversationAdapter } from "./types";
import { VOICE_CONVERSATION_TOOLS } from "./conversation-tools";

export function openAIConversationConfig(config: {
  model: string;
  voice: string;
  language: "en" | "pt";
}) {
  return {
    expires_after: { anchor: "created_at", seconds: 60 },
    session: {
      type: "realtime",
      model: config.model,
      instructions: `${VOICE_COMPANION_PROMPT}\n\nStart in ${config.language === "pt" ? "Portuguese" : "English"}, and follow the user's language.`,
      output_modalities: ["audio"],
      max_output_tokens: 512,
      tools: VOICE_CONVERSATION_TOOLS.map((tool) => ({
        ...tool,
        type: "function",
      })),
      tool_choice: "auto",
      audio: {
        input: {
          transcription: {
            model: "gpt-4o-mini-transcribe",
            language: config.language,
          },
          turn_detection: {
            type: "semantic_vad",
            eagerness: "medium",
            create_response: true,
            interrupt_response: true,
          },
        },
        output: { voice: config.voice },
      },
    },
  };
}

export class OpenAIConversationAdapter implements ConversationAdapter {
  constructor(
    private readonly config: { apiKey: string; model: string; voice: string },
  ) {}

  async createSession(
    input: Parameters<ConversationAdapter["createSession"]>[0],
  ) {
    const response = await fetch(
      "https://api.openai.com/v1/realtime/client_secrets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "OpenAI-Safety-Identifier": input.safetyIdentifier,
        },
        body: JSON.stringify(
          openAIConversationConfig({
            ...this.config,
            language: input.language,
          }),
        ),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenAI Realtime request failed (${response.status})`);
    }
    const { value } = z
      .object({ value: z.string().min(1) })
      .parse(await response.json());
    return { provider: "openai" as const, clientSecret: value };
  }
}
