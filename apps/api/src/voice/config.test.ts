import { expect, test } from "bun:test";
import { resolveVoiceConfig } from "./config";

const defaults = {
  voiceConversationProvider: "elevenlabs" as const,
  openaiLiveModel: "live-default",
  elevenlabsConversationModel: "conversation-default",
};

test("null org overrides inherit deployment defaults", () => {
  expect(resolveVoiceConfig(defaults, null)).toEqual({
    provider: "elevenlabs",
    model: "conversation-default",
  });
  expect(
    resolveVoiceConfig(defaults, { voice_provider: null, voice_model: null }),
  ).toEqual(resolveVoiceConfig(defaults));
});

test("an org chooses either provider and inherits that provider's model", () => {
  expect(
    resolveVoiceConfig(defaults, {
      voice_provider: "openai",
      voice_model: null,
    }),
  ).toEqual({ provider: "openai", model: "live-default" });
  expect(
    resolveVoiceConfig(
      { ...defaults, voiceConversationProvider: "openai" },
      {
        voice_provider: "elevenlabs",
        voice_model: " custom-conversation-model ",
      },
    ),
  ).toEqual({ provider: "elevenlabs", model: "custom-conversation-model" });
});

test("invalid overrides fail instead of silently selecting another provider", () => {
  for (const override of [
    { voice_provider: "unknown", voice_model: null },
    { voice_provider: null, voice_model: "model-without-provider" },
    { voice_provider: "openai", voice_model: " " },
    { voice_provider: "openai", voice_model: "x".repeat(129) },
  ])
    expect(() => resolveVoiceConfig(defaults, override)).toThrow();
});
