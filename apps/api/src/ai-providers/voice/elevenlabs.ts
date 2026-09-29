import { z } from "zod";
import { createHash } from "node:crypto";
import type { SpeechAdapter } from "./types";
import { voiceConversationConfig } from "./conversation-config";

export class ElevenLabsSpeechAdapter implements SpeechAdapter {
  readonly conversationKey: string;
  private readonly configurationKey: string;
  constructor(
    private readonly config: {
      apiKey: string;
      voiceId: string;
      model: string;
    },
  ) {
    this.configurationKey = createHash("sha256")
      .update(JSON.stringify(voiceConversationConfig(config)))
      .digest("hex");
    this.conversationKey = createHash("sha256")
      .update(config.apiKey)
      .update("\0")
      .update(this.configurationKey)
      .digest("hex");
  }

  private async request(path: string, body: unknown, signal: AbortSignal) {
    const response = await fetch(`https://api.elevenlabs.io/v1${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "xi-api-key": this.config.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    // Provider errors can contain credentials or user text.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`ElevenLabs request failed (${response.status})`);
    }
    return response;
  }

  async ensureConversationAgent(): Promise<string> {
    const name = `Studio voice ${this.configurationKey.slice(0, 24)}`;
    const response = await this.request(
      `/convai/agents?search=${encodeURIComponent(name)}&page_size=100`,
      undefined,
      AbortSignal.timeout(15_000),
    );
    const { agents } = z
      .object({
        agents: z.array(z.object({ agent_id: z.string(), name: z.string() })),
      })
      .parse(await response.json());
    const existing = agents.find((agent) => agent.name === name);
    if (existing) {
      const details = await this.request(
        `/convai/agents/${encodeURIComponent(existing.agent_id)}`,
        undefined,
        AbortSignal.timeout(15_000),
      );
      // Reuse only private agents; a dashboard edit must not open public usage.
      z.object({
        platform_settings: z.object({
          auth: z.object({ enable_auth: z.literal(true) }),
        }),
      }).parse(await details.json());
      return existing.agent_id;
    }
    const created = await this.request(
      "/convai/agents/create",
      { name, ...voiceConversationConfig(this.config) },
      AbortSignal.timeout(15_000),
    );
    return z.object({ agent_id: z.string().min(1) }).parse(await created.json())
      .agent_id;
  }

  async createConversationToken(agentId: string): Promise<string> {
    const response = await this.request(
      `/convai/conversation/token?agent_id=${encodeURIComponent(agentId)}`,
      undefined,
      AbortSignal.timeout(15_000),
    );
    return z.object({ token: z.string().min(1) }).parse(await response.json())
      .token;
  }

  async createTranscriptionToken(): Promise<string> {
    const response = await this.request(
      "/single-use-token/realtime_scribe",
      {},
      AbortSignal.timeout(15_000),
    );
    return z.object({ token: z.string().min(1) }).parse(await response.json())
      .token;
  }

  synthesize(text: string, signal: AbortSignal): Promise<Response> {
    return this.request(
      `/text-to-speech/${encodeURIComponent(this.config.voiceId)}/stream?output_format=mp3_44100_128`,
      { text, model_id: this.config.model },
      AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
    );
  }
}
