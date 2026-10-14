import { describe, expect, test } from "bun:test";
import { AI_PROVIDER_CREDITS } from "./credits";
import {
  AI_PROVIDER_KEY_CREATE,
  rejectPrivateOpenAiCompatibleBaseUrl,
} from "./key-create";
import { AI_PROVIDER_KEY_LIST } from "./key-list";
import { AI_PROVIDER_OAUTH_EXCHANGE } from "./oauth-exchange";
import { AI_PROVIDER_OAUTH_URL } from "./oauth-url";
import { AI_PROVIDER_PROVISION_KEY } from "./provision-key";
import { AI_PROVIDER_TOPUP_URL } from "./topup-url";

interface HostedProviderTarget {
  name: string;
  parse: (providerId: string) => boolean;
}

const hostedProviderTargets: HostedProviderTarget[] = [
  {
    name: "key creation",
    parse: (providerId: string) =>
      AI_PROVIDER_KEY_CREATE.inputSchema.safeParse({
        providerId,
        label: "Provider key",
        apiKey: "test-key",
      }).success,
  },
  {
    name: "OAuth exchange",
    parse: (providerId: string) =>
      AI_PROVIDER_OAUTH_EXCHANGE.inputSchema.safeParse({
        providerId,
        code: "test-code",
        stateToken: "test-state",
        label: "OAuth key",
      }).success,
  },
  {
    name: "key provisioning",
    parse: (providerId: string) =>
      AI_PROVIDER_PROVISION_KEY.inputSchema.safeParse({ providerId }).success,
  },
  {
    name: "OAuth URL generation",
    parse: (providerId: string) =>
      AI_PROVIDER_OAUTH_URL.inputSchema.safeParse({
        providerId,
        callbackUrl: "http://localhost:3000/oauth/callback/ai-provider",
      }).success,
  },
  {
    name: "credit lookup",
    parse: (providerId: string) =>
      AI_PROVIDER_CREDITS.inputSchema.safeParse({ providerId }).success,
  },
  {
    name: "credit top-up",
    parse: (providerId: string) =>
      AI_PROVIDER_TOPUP_URL.inputSchema.safeParse({
        providerId,
        amountCents: 1_000,
      }).success,
  },
];

describe("hosted AI provider schemas", () => {
  test.each(hostedProviderTargets)(
    "$name rejects native-only provider IDs",
    ({ parse }) => {
      expect(parse("claude-code")).toBeFalse();
      expect(parse("codex")).toBeFalse();
    },
  );

  test.each(hostedProviderTargets)(
    "$name accepts a hosted provider ID",
    ({ parse }) => {
      expect(parse("deco")).toBeTrue();
    },
  );

  test("rejects an oversized apiKey", () => {
    expect(
      AI_PROVIDER_KEY_CREATE.inputSchema.safeParse({
        providerId: "deco",
        label: "Provider key",
        apiKey: "a".repeat(4097),
      }).success,
    ).toBeFalse();
  });

  test("rejects an openai-compatible baseUrl targeting a private network", () => {
    expect(() =>
      rejectPrivateOpenAiCompatibleBaseUrl(
        "openai-compatible",
        JSON.stringify({
          baseUrl: "http://169.254.169.254/latest",
          apiKey: "x",
        }),
      ),
    ).toThrow();
    expect(() =>
      rejectPrivateOpenAiCompatibleBaseUrl(
        "openai-compatible",
        JSON.stringify({ baseUrl: "http://10.0.0.5", apiKey: "x" }),
      ),
    ).toThrow();
  });

  test("allows an openai-compatible baseUrl targeting a public host", () => {
    expect(() =>
      rejectPrivateOpenAiCompatibleBaseUrl(
        "openai-compatible",
        JSON.stringify({ baseUrl: "https://api.example.com", apiKey: "x" }),
      ),
    ).not.toThrow();
  });

  test("ignores other providers and malformed credentials", () => {
    expect(() =>
      rejectPrivateOpenAiCompatibleBaseUrl("deco", "plain-api-key"),
    ).not.toThrow();
    expect(() =>
      rejectPrivateOpenAiCompatibleBaseUrl("openai-compatible", "not-json"),
    ).not.toThrow();
  });

  test("keeps historical native-only keys listable", () => {
    expect(
      AI_PROVIDER_KEY_LIST.inputSchema.safeParse({
        providerId: "claude-code",
      }).success,
    ).toBeTrue();
    expect(
      AI_PROVIDER_KEY_LIST.inputSchema.safeParse({ providerId: "codex" })
        .success,
    ).toBeTrue();
  });
});
