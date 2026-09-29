import { z } from "zod";
import type { SpeechAdapter } from "./types";

export class ElevenLabsSpeechAdapter implements SpeechAdapter {
  constructor(
    private readonly config: {
      apiKey: string;
      voiceId: string;
      model: string;
    },
  ) {}

  private async request(path: string, body: unknown, signal: AbortSignal) {
    const response = await fetch(`https://api.elevenlabs.io/v1${path}`, {
      method: "POST",
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
