import { z } from "zod";
import { VOICE_LIVE_PROMPT } from "@decocms/shared/voice";
import type { ConversationAdapter } from "./types";

export function openAIConversationConfig(config: {
  model: string;
  voice: string;
  language: "en" | "pt";
}) {
  return {
    model: config.model,
    instructions: `${VOICE_LIVE_PROMPT}\nStart in ${config.language === "pt" ? "Brazilian Portuguese" : "English"}, and follow the user's language.`,
    delegation: { type: "client" },
    audio: { output: { voice: config.voice } },
    store: false,
  };
}

export class OpenAIConversationAdapter implements ConversationAdapter {
  constructor(private readonly config: { apiKey: string; voice: string }) {}

  async createSession() {
    return { provider: "openai" as const, transport: "webrtc" as const };
  }

  async negotiate(input: {
    sdp: string;
    language: "en" | "pt";
    model: string;
    safetyIdentifier: string;
  }) {
    const response = await fetch("https://api.openai.com/v1/live/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": input.safetyIdentifier,
      },
      body: JSON.stringify({
        session: openAIConversationConfig({
          ...this.config,
          language: input.language,
          model: input.model,
        }),
        transport: { type: "webrtc", sdp: input.sdp },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`OpenAI Live request failed (${response.status})`);
    }
    const result = z
      .object({
        session: z.object({ id: z.string().min(1) }),
        transport: z.object({
          type: z.literal("webrtc"),
          sdp: z.string().min(1).max(100_000),
        }),
      })
      .parse(await response.json());
    return { sdp: result.transport.sdp };
  }
}
