import { afterEach, describe, expect, test } from "bun:test";
import { isServiceTokenPath } from "../middleware/resolve-org-from-path";
import {
  channelAccountClaimBodySchema,
  channelAccountDisconnectBodySchema,
  channelAccountTokenBodySchema,
  isChannelsReturnUrl,
  isChannelsServiceToken,
} from "./channel-accounts-service";

const original = process.env.CHANNELS_SERVICE_TOKEN;

afterEach(() => {
  if (original === undefined) delete process.env.CHANNELS_SERVICE_TOKEN;
  else process.env.CHANNELS_SERVICE_TOKEN = original;
});

describe("the channels service's secret", () => {
  test("nothing is accepted while it isn't configured", () => {
    delete process.env.CHANNELS_SERVICE_TOKEN;
    expect(isChannelsServiceToken("")).toBe(false);
    expect(isChannelsServiceToken("anything")).toBe(false);
  });

  test("only the exact secret is accepted", () => {
    process.env.CHANNELS_SERVICE_TOKEN = "channels-secret";
    expect(isChannelsServiceToken("channels-secret")).toBe(true);
    expect(isChannelsServiceToken("channels-secret ")).toBe(false);
    expect(isChannelsServiceToken("other")).toBe(false);
  });
});

describe("where a connect link may send the person back", () => {
  const service = "https://channels.example";

  test("only the channels service's own origin, over https", () => {
    expect(
      isChannelsReturnUrl(
        "https://channels.example/studio/connected?c=1",
        service,
      ),
    ).toBe(true);
    expect(isChannelsReturnUrl("https://evil.example/x", service)).toBe(false);
    expect(
      isChannelsReturnUrl("https://channels.example.evil.example/x", service),
    ).toBe(false);
    expect(isChannelsReturnUrl("http://channels.example/x", service)).toBe(
      false,
    );
    expect(isChannelsReturnUrl("javascript:alert(1)", service)).toBe(false);
    expect(isChannelsReturnUrl("not a url", service)).toBe(false);
  });

  test("nowhere while the service's URL isn't configured", () => {
    expect(isChannelsReturnUrl("https://channels.example/x", undefined)).toBe(
      false,
    );
  });

  test("a local service may use http", () => {
    expect(
      isChannelsReturnUrl("http://localhost:8787/x", "http://localhost:8787"),
    ).toBe(true);
  });
});

describe("what the channels service may send", () => {
  test("a token request names one account, nothing else", () => {
    expect(
      channelAccountTokenBodySchema.safeParse({
        channel: "slack",
        account_id: "T1:U1",
      }).success,
    ).toBe(true);
    for (const bad of [
      {},
      { channel: "Slack", account_id: "U1" },
      { channel: "slack", account_id: "" },
      { channel: "slack", account_id: "U1", user_id: "someone" },
    ]) {
      expect(channelAccountTokenBodySchema.safeParse(bad).success).toBe(false);
    }
  });

  test("a claim can't name the user it is for", () => {
    const claim = {
      channel: "discord",
      account_id: "123",
      account_name: "Ana",
      return_url: "https://channels.example/studio/connected",
    };
    expect(channelAccountClaimBodySchema.safeParse(claim).success).toBe(true);
    expect(
      channelAccountClaimBodySchema.safeParse({ ...claim, user_id: "u" })
        .success,
    ).toBe(false);
    expect(
      channelAccountClaimBodySchema.safeParse({
        ...claim,
        account_email: "not-an-email",
      }).success,
    ).toBe(false);
  });

  test("a disconnect names one account or a prefix, never neither", () => {
    expect(
      channelAccountDisconnectBodySchema.safeParse({
        channel: "slack",
        account_prefix: "T1:",
      }).success,
    ).toBe(true);
    expect(
      channelAccountDisconnectBodySchema.safeParse({ channel: "slack" })
        .success,
    ).toBe(false);
    expect(
      channelAccountDisconnectBodySchema.safeParse({
        channel: "slack",
        account_prefix: "",
      }).success,
    ).toBe(false);
  });
});

describe("the channels routes resolve the organization by id", () => {
  test("exactly these three paths", () => {
    for (const path of ["", "/token", "/claims"]) {
      expect(
        isServiceTokenPath(`/api/org_1/internal/channel-accounts${path}`),
      ).toBe(true);
    }
    expect(
      isServiceTokenPath("/api/org_1/internal/channel-accounts/token/extra"),
    ).toBe(false);
    expect(isServiceTokenPath("/api/org_1/internal/channel-accounts/x")).toBe(
      false,
    );
  });
});
