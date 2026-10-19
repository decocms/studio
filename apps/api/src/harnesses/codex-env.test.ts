import { describe, expect, test } from "bun:test";
import { codexEnvFromCredential } from "./codex-env";

describe("Codex credentials", () => {
  test("subscription auth clears API credentials and provider overrides", () => {
    const env = codexEnvFromCredential(
      {
        providerId: "codex-subscription",
        apiKey: "auth_example",
        baseUrl: "https://unused.example.com",
      },
      "openai/gpt-6.1-sol",
    );
    expect(env).toMatchObject({
      CODEX_MODEL: "gpt-6.1-sol",
      STUDIO_CODEX_AUTH_JSON: "auth_example",
      CODEX_API_KEY: null,
      OPENAI_API_KEY: null,
      OPENAI_BASE_URL: null,
      ANTHROPIC_API_KEY: null,
      CLAUDE_CODE_OAUTH_TOKEN: null,
    });
  });

  test("Responses API credentials clear subscription auth", () => {
    expect(
      codexEnvFromCredential(
        {
          providerId: "openai-compatible",
          apiKey: "key_example",
          baseUrl: "https://provider.example.com/v1",
        },
        "gpt-6.1-sol",
      ),
    ).toMatchObject({
      STUDIO_CODEX_AUTH_JSON: null,
      CODEX_API_KEY: "key_example",
      OPENAI_BASE_URL: "https://provider.example.com/v1",
    });
  });

  test("rejects incompatible providers and missing endpoints before provisioning", () => {
    expect(() =>
      codexEnvFromCredential({
        providerId: "anthropic",
        apiKey: "key_example",
      }),
    ).toThrow(/Responses API/);
    expect(() =>
      codexEnvFromCredential({
        providerId: "openai-compatible",
        apiKey: "key_example",
      }),
    ).toThrow(/base URL/);
  });
});
