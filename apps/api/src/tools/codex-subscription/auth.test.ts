import { describe, expect, test } from "bun:test";
import { normalizeCodexAuth } from "./auth";

const credentials = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    access_token: "access_example",
    refresh_token: "refresh_example",
    id_token: "id_example",
    account_id: "account_example",
  },
  last_refresh: "2026-01-01T00:00:00Z",
};

describe("Codex subscription credentials", () => {
  test("keeps the refreshable ChatGPT cache and strips unrelated fields", () => {
    expect(
      JSON.parse(
        normalizeCodexAuth(
          JSON.stringify({
            ...credentials,
            extra: "discard",
            tokens: { ...credentials.tokens, other: "discard" },
          }),
        ),
      ),
    ).toEqual(credentials);
  });

  test.each([
    "",
    "null",
    "[]",
    "{}",
    "not json",
    JSON.stringify({ OPENAI_API_KEY: "sk-example" }),
    JSON.stringify({ ...credentials, OPENAI_API_KEY: "sk-example" }),
    JSON.stringify({
      ...credentials,
      tokens: { ...credentials.tokens, refresh_token: "" },
    }),
    JSON.stringify({
      ...credentials,
      tokens: { ...credentials.tokens, access_token: "a b" },
    }),
    JSON.stringify({
      ...credentials,
      tokens: { ...credentials.tokens, access_token: "a".repeat(32769) },
    }),
  ])("rejects invalid, non-subscription, or oversized credentials", (value) => {
    expect(() => normalizeCodexAuth(value)).toThrow();
  });

  test("does not echo credential values in validation errors", () => {
    try {
      normalizeCodexAuth(
        JSON.stringify({
          ...credentials,
          auth_mode: "api",
          OPENAI_API_KEY: "secret_example",
        }),
      );
    } catch (error) {
      expect(String(error)).not.toContain("secret_example");
    }
  });
});
