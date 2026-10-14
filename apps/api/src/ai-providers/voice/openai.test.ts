import { expect, test } from "bun:test";
import { openAIConversationConfig } from "./openai";
import { resolveConfig } from "../../settings/resolve-config";
import { resolveVoiceConfig } from "../../voice/config";
import { VoiceSessionSchema } from "@decocms/shared/voice";

const flags = { port: "", home: "", localMode: false, skipMigrations: false };

test("OpenAI Live delegates to the existing agent without registering Realtime tools", () => {
  const config = openAIConversationConfig({
    model: "gpt-live-1",
    voice: "marin",
    language: "pt",
  });
  expect(config.delegation).toEqual({ type: "client" });
  expect(config.instructions).toContain("Portuguese");
  expect(config.instructions).toContain("Claude Code");
  expect(config).not.toHaveProperty("tools");
  expect(config).not.toHaveProperty("type");
  expect(config.store).toBe(false);
});

test("invalid provider defaults reject voice creation without rejecting API configuration", () => {
  expect(resolveConfig(flags, {}).settings.voiceConversationProvider).toBe(
    "elevenlabs",
  );
  const { settings } = resolveConfig(flags, {
    VOICE_CONVERSATION_PROVIDER: "openai",
    OPENAI_LIVE_API_KEY: "synthetic-key",
    OPENAI_LIVE_MODEL: " model-example ",
    OPENAI_LIVE_VOICE: "cedar",
  });
  expect(settings.voiceConversationProvider).toBe("openai");
  expect(settings.openaiLiveModel).toBe("model-example");
  expect(settings.openaiLiveVoice).toBe("cedar");
  expect(settings.elevenlabsApiKey).toBeUndefined();
  const invalid = resolveConfig(flags, {
    VOICE_CONVERSATION_PROVIDER: "unknown",
  }).settings;
  expect(invalid.voiceConversationProvider).toBeNull();
  expect(() => resolveVoiceConfig(invalid)).toThrow();
  expect(
    resolveVoiceConfig(invalid, {
      voice_provider: "openai",
      voice_model: null,
    }),
  ).toEqual({ provider: "openai", model: "gpt-live-1" });
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
      transport: "webrtc",
      conversationToken: "wrong-provider-token",
    }),
  ).toEqual({
    ...grant,
    provider: "openai",
    transport: "webrtc",
  });
  expect(
    VoiceSessionSchema.safeParse({
      ...grant,
      provider: "openai",
      conversationToken: "wrong-provider-token",
    }).success,
  ).toBe(false);
});
