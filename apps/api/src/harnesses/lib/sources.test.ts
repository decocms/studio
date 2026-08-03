import { describe, expect, test } from "bun:test";
import { createSecretModelSource } from "./sources";

describe("createSecretModelSource", () => {
  test("builds a plain secret model source", () => {
    expect(
      createSecretModelSource({
        providerId: "anthropic",
        apiKey: "sk-ant",
        modelId: "claude-3-5-sonnet",
      }),
    ).toEqual({
      kind: "secret",
      providerId: "anthropic",
      apiKey: "sk-ant",
      modelId: "claude-3-5-sonnet",
    });
  });

  test("unpacks openai-compatible JSON credentials", () => {
    expect(
      createSecretModelSource({
        providerId: "openai-compatible",
        apiKey: JSON.stringify({
          apiKey: "sk-litellm",
          baseUrl: "https://litellm.example.com/v1",
        }),
        modelId: "gpt-4.1",
      }),
    ).toEqual({
      kind: "secret",
      providerId: "openai-compatible",
      apiKey: "sk-litellm",
      modelId: "gpt-4.1",
      baseUrl: "https://litellm.example.com/v1",
    });
  });
});
