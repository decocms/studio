import { describe, expect, it } from "bun:test";
import { discordAdapter } from "./discord";
import { teamsAdapter } from "./teams";

describe("discordAdapter", () => {
  it("answers a PING with a PONG and does no work", () => {
    expect(discordAdapter.parseInbound({ type: 1 })).toEqual({
      kind: "ack",
      response: { type: 1 },
    });
  });

  it("parses a slash command into a deferred message", () => {
    const parsed = discordAdapter.parseInbound({
      type: 2,
      id: "i1",
      token: "tok",
      application_id: "app1",
      channel_id: "chan1",
      member: { user: { id: "u1", global_name: "Ada" } },
      data: { name: "ask", options: [{ name: "message", value: "hi there" }] },
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.text).toBe("hi there");
    expect(parsed.message.senderName).toBe("Ada");
    expect(parsed.message.conversationKey).toBe("chan1");
    expect(parsed.message.conversationRef.interactionToken).toBe("tok");
    expect(parsed.ackResponse).toEqual({ type: 5 });
  });

  it("rejects a bad signature without throwing", async () => {
    const ok = await discordAdapter.verifySignature({
      rawBody: new TextEncoder().encode("{}").buffer,
      headers: new Headers({
        "x-signature-ed25519": "00".repeat(64),
        "x-signature-timestamp": "1",
      }),
      credentials: {
        publicKey: "aa".repeat(32),
        applicationId: "a",
        botToken: "b",
      },
    });
    expect(ok).toBe(false);
  });

  it("masks the bot token, leaving the application id visible", () => {
    const masked = discordAdapter.maskCredentials({
      applicationId: "12345",
      publicKey: "abcdef0123456789",
      botToken: "supersecrettoken",
    });
    expect(masked.applicationId).toBe("12345");
    expect(masked.botToken).toMatch(/oken$/);
    expect(masked.botToken).not.toContain("supersecret");
  });
});

describe("teamsAdapter", () => {
  it("acks non-message activities", () => {
    expect(teamsAdapter.parseInbound({ type: "conversationUpdate" })).toEqual({
      kind: "ack",
    });
  });

  it("parses a message activity with its conversation reference", () => {
    const parsed = teamsAdapter.parseInbound({
      type: "message",
      text: "hello bot",
      from: { id: "29:abc", name: "Grace" },
      serviceUrl: "https://smba.trafficmanager.net/teams/",
      conversation: { id: "conv-1" },
    });
    expect(parsed.kind).toBe("message");
    if (parsed.kind !== "message") return;
    expect(parsed.message.text).toBe("hello bot");
    expect(parsed.message.senderName).toBe("Grace");
    expect(parsed.message.conversationKey).toBe("conv-1");
    expect(parsed.message.conversationRef.serviceUrl).toBe(
      "https://smba.trafficmanager.net/teams/",
    );
  });

  it("rejects an inbound request with no bearer token", async () => {
    const ok = await teamsAdapter.verifySignature({
      rawBody: new TextEncoder().encode("{}").buffer,
      headers: new Headers(),
      credentials: { appId: "a", appPassword: "p" },
    });
    expect(ok).toBe(false);
  });
});
