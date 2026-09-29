import { expect, test } from "bun:test";
import { openAIConversationConfig } from "./openai";
import { voiceConversationConfig } from "./conversation-config";
import { resolveConfig } from "../../settings/resolve-config";
import { VoiceSessionSchema } from "@decocms/shared/voice";

const flags = { port: "", home: "", localMode: false, skipMigrations: false };

test("OpenAI session configuration preserves the same delegation contract as ElevenLabs", () => {
  const openai = openAIConversationConfig({
    model: "gpt-realtime-2.1",
    voice: "marin",
    language: "pt",
  });
  const elevenlabs = voiceConversationConfig({
    model: "speech-example",
    voiceId: "voice-example",
    conversationModel: "conversation-example",
  });
  expect(
    openai.session.tools.map(({ name, parameters }) => ({ name, parameters })),
  ).toEqual(
    elevenlabs.conversation_config.agent.prompt.tools.map(
      ({ name, parameters }) => ({ name, parameters }),
    ),
  );
  expect(openai.session.instructions).toContain("Portuguese");
  expect(openai.session.audio.input.turn_detection.interrupt_response).toBe(
    true,
  );
  expect(openai.expires_after.seconds).toBe(60);
});

test("provider selection is explicit and rejects unsupported values", () => {
  expect(resolveConfig(flags, {}).settings.voiceConversationProvider).toBe(
    "elevenlabs",
  );
  const { settings } = resolveConfig(flags, {
    VOICE_CONVERSATION_PROVIDER: "openai",
    OPENAI_REALTIME_API_KEY: "synthetic-key",
    OPENAI_REALTIME_MODEL: " model-example ",
    OPENAI_REALTIME_VOICE: "cedar",
  });
  expect(settings.voiceConversationProvider).toBe("openai");
  expect(settings.openaiRealtimeModel).toBe("model-example");
  expect(settings.openaiRealtimeVoice).toBe("cedar");
  expect(settings.elevenlabsApiKey).toBeUndefined();
  expect(() =>
    resolveConfig(flags, { VOICE_CONVERSATION_PROVIDER: "unknown" }),
  ).toThrow("VOICE_CONVERSATION_PROVIDER");
});

test("bootstrap accepts both providers and legacy ElevenLabs responses without mixing credentials", () => {
  const grant = { token: "synthetic-grant", expiresAt: 123 };
  expect(
    VoiceSessionSchema.parse({
      ...grant,
      conversationToken: "synthetic-elevenlabs-token",
    }).provider,
  ).toBe("elevenlabs");
  expect(
    VoiceSessionSchema.parse({
      ...grant,
      provider: "openai",
      clientSecret: "synthetic-openai-token",
      conversationToken: "wrong-provider-token",
    }),
  ).toEqual({
    ...grant,
    provider: "openai",
    clientSecret: "synthetic-openai-token",
  });
  expect(
    VoiceSessionSchema.safeParse({
      ...grant,
      provider: "openai",
      conversationToken: "wrong-provider-token",
    }).success,
  ).toBe(false);
});
