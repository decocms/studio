import { expect, test } from "bun:test";
import { ElevenLabsSpeechAdapter } from "./elevenlabs";

test("conversation caches are isolated by provider credentials and configuration", () => {
  const config = {
    apiKey: "synthetic-account-a",
    voiceId: "voice-example",
    model: "model-example",
    conversationModel: "conversation-model-example",
  };
  const identity = new ElevenLabsSpeechAdapter(config).conversationKey;
  expect(new ElevenLabsSpeechAdapter({ ...config }).conversationKey).toBe(
    identity,
  );
  for (const change of [
    { apiKey: "synthetic-account-b" },
    { voiceId: "voice-other" },
    { model: "model-other" },
    { conversationModel: "conversation-model-other" },
  ]) {
    expect(
      new ElevenLabsSpeechAdapter({ ...config, ...change }).conversationKey,
    ).not.toBe(identity);
  }
  expect(identity).not.toContain(config.apiKey);
});
