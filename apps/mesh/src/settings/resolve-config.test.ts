import { describe, expect, it } from "bun:test";
import { resolveConfig } from "./resolve-config";
import type { CliFlags } from "./types";

const flags: CliFlags = {
  port: "",
  home: "",
  localMode: false,
  skipMigrations: false,
};

describe("resolveConfig sandbox provider kind", () => {
  it("accepts canonical agent-sandbox", () => {
    const result = resolveConfig(flags, {
      STUDIO_SANDBOX_PROVIDER: "agent-sandbox",
    });

    expect(result.settings.sandboxProviderKind).toBe("agent-sandbox");
  });

  it("normalizes legacy cluster to agent-sandbox", () => {
    const result = resolveConfig(flags, {
      STUDIO_SANDBOX_PROVIDER: "cluster",
    });

    expect(result.settings.sandboxProviderKind).toBe("agent-sandbox");
  });
});

describe("resolveConfig NATS tunnel settings", () => {
  it("enables public tunnel when NATS_PUBLIC_URL is set and flag is unset", () => {
    const result = resolveConfig(flags, {
      NATS_PUBLIC_URL: "wss://nats.example.com",
    });

    expect(result.settings.natsPublicUrl).toBe("wss://nats.example.com");
    expect(result.settings.natsTunnelPublicEnabled).toBe(true);
  });

  it("disables public tunnel when flag is explicitly false even with NATS_PUBLIC_URL", () => {
    const result = resolveConfig(flags, {
      NATS_PUBLIC_URL: "wss://nats.example.com",
      NATS_TUNNEL_PUBLIC_ENABLED: "false",
    });

    expect(result.settings.natsTunnelPublicEnabled).toBe(false);
  });

  it("enables public tunnel when flag is explicitly true without NATS_PUBLIC_URL", () => {
    const result = resolveConfig(flags, {
      NATS_TUNNEL_PUBLIC_ENABLED: "true",
    });

    expect(result.settings.natsTunnelPublicEnabled).toBe(true);
  });

  it("defaults session TTL to 900", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.natsTunnelSessionTtlSeconds).toBe(900);
  });

  it("uses NATS_TUNNEL_SESSION_TTL_SECONDS when set", () => {
    const result = resolveConfig(flags, {
      NATS_TUNNEL_SESSION_TTL_SECONDS: "1200",
    });

    expect(result.settings.natsTunnelSessionTtlSeconds).toBe(1200);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid session TTL %p",
    (ttl) => {
      expect(() =>
        resolveConfig(flags, {
          NATS_TUNNEL_SESSION_TTL_SECONDS: ttl,
        }),
      ).toThrow("NATS_TUNNEL_SESSION_TTL_SECONDS must be a positive integer");
    },
  );
});
