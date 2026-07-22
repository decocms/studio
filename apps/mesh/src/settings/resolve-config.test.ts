import { describe, expect, it } from "bun:test";
import { resolveConfig, resolveShutdownDrainMs } from "./resolve-config";
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

describe("resolveConfig deployment admin emails", () => {
  it("defaults to an empty list when unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.deploymentAdminEmails).toEqual([]);
  });

  it("normalizes case, whitespace, and trailing commas", () => {
    const result = resolveConfig(flags, {
      DEPLOYMENT_ADMIN_EMAILS: " Alice@Example.com, bob@example.com ,,",
    });

    expect(result.settings.deploymentAdminEmails).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });
});

describe("resolveShutdownDrainMs", () => {
  const forceExitMs = 115_000;

  it("worker skips the NLB drain (not a frontdoor target)", () => {
    expect(resolveShutdownDrainMs("worker", forceExitMs, undefined)).toBe(0);
  });

  it("api and all drain ~60% of the force-exit budget", () => {
    expect(resolveShutdownDrainMs("api", forceExitMs, undefined)).toBe(69_000);
    expect(resolveShutdownDrainMs("all", forceExitMs, undefined)).toBe(69_000);
  });

  it("SHUTDOWN_DRAIN_MS overrides every role", () => {
    expect(resolveShutdownDrainMs("worker", forceExitMs, "5000")).toBe(5_000);
    expect(resolveShutdownDrainMs("api", forceExitMs, "0")).toBe(0);
  });
});

describe("resolveConfig STUDIO_* env vars with MESH_* fallback", () => {
  it("reads STUDIO_JWT_SECRET, preferring it over MESH_JWT_SECRET", () => {
    const result = resolveConfig(flags, {
      STUDIO_JWT_SECRET: "new-secret",
      MESH_JWT_SECRET: "old-secret",
    });

    expect(result.settings.studioJwtSecret).toBe("new-secret");
  });

  it("falls back to legacy MESH_JWT_SECRET", () => {
    const result = resolveConfig(flags, { MESH_JWT_SECRET: "old-secret" });

    expect(result.settings.studioJwtSecret).toBe("old-secret");
  });

  it("reads STUDIO_DISPATCH_ROLE, preferring it over MESH_DISPATCH_ROLE", () => {
    const result = resolveConfig(flags, {
      STUDIO_DISPATCH_ROLE: "worker",
      MESH_DISPATCH_ROLE: "api",
    });

    expect(result.settings.dispatchRole).toBe("worker");
  });

  it("falls back to legacy MESH_DISPATCH_ROLE", () => {
    const result = resolveConfig(flags, { MESH_DISPATCH_ROLE: "api" });

    expect(result.settings.dispatchRole).toBe("api");
  });

  it("defaults dispatch role to all when neither is set", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.dispatchRole).toBe("all");
  });
});
