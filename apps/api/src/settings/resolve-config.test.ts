import { describe, expect, it } from "bun:test";
import {
  describeEncryptionKeyForLog,
  resolveConfig,
  resolveShutdownDrainMs,
} from "./resolve-config";
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

  it("trims surrounding whitespace/newlines instead of throwing", () => {
    const result = resolveConfig(flags, {
      STUDIO_SANDBOX_PROVIDER: "agent-sandbox\n",
    });

    expect(result.settings.sandboxProviderKind).toBe("agent-sandbox");
  });

  it("still throws for a genuinely unknown value", () => {
    expect(() =>
      resolveConfig(flags, { STUDIO_SANDBOX_PROVIDER: "bogus" }),
    ).toThrow(/Unknown STUDIO_SANDBOX_PROVIDER/);
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

describe("resolveConfig database pool max", () => {
  it("defaults to 5 when unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.databasePoolMax).toBe(5);
  });

  it("uses DATABASE_POOL_MAX when set", () => {
    const result = resolveConfig(flags, { DATABASE_POOL_MAX: "20" });

    expect(result.settings.databasePoolMax).toBe(20);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid pool max %p",
    (value) => {
      expect(() => resolveConfig(flags, { DATABASE_POOL_MAX: value })).toThrow(
        "DATABASE_POOL_MAX must be a positive integer",
      );
    },
  );
});

describe("resolveConfig port", () => {
  it("defaults to 3000 when unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.port).toBe(3000);
  });

  it("uses PORT when set", () => {
    const result = resolveConfig(flags, { PORT: "8080" });

    expect(result.settings.port).toBe(8080);
  });

  it("prefers the --port flag over PORT", () => {
    const result = resolveConfig({ ...flags, port: "9000" }, { PORT: "8080" });

    expect(result.settings.port).toBe(9000);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid PORT %p",
    (value) => {
      expect(() => resolveConfig(flags, { PORT: value })).toThrow(
        "PORT must be a positive integer",
      );
    },
  );
});

describe("resolveConfig clickhouse max memory usage", () => {
  it("defaults to undefined when unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.clickhouseMaxMemoryUsage).toBeUndefined();
  });

  it("uses CLICKHOUSE_MAX_MEMORY_USAGE when set", () => {
    const result = resolveConfig(flags, {
      CLICKHOUSE_MAX_MEMORY_USAGE: "1000000000",
    });

    expect(result.settings.clickhouseMaxMemoryUsage).toBe(1000000000);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid value %p",
    (value) => {
      expect(() =>
        resolveConfig(flags, { CLICKHOUSE_MAX_MEMORY_USAGE: value }),
      ).toThrow("CLICKHOUSE_MAX_MEMORY_USAGE must be a positive integer");
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

describe("resolveConfig Studio environment aliases", () => {
  it("prefers Studio JWT and dispatch variables", () => {
    const result = resolveConfig(flags, {
      STUDIO_JWT_SECRET: "studio-secret",
      MESH_JWT_SECRET: "legacy-secret",
      STUDIO_DISPATCH_ROLE: "api",
      MESH_DISPATCH_ROLE: "worker",
    });

    expect(result.settings.studioJwtSecret).toBe("studio-secret");
    expect(result.settings.dispatchRole).toBe("api");
  });

  it("accepts legacy variables during the compatibility window", () => {
    const result = resolveConfig(flags, {
      MESH_JWT_SECRET: "legacy-secret",
      MESH_DISPATCH_ROLE: "worker",
    });

    expect(result.settings.studioJwtSecret).toBe("legacy-secret");
    expect(result.settings.dispatchRole).toBe("worker");
  });
});

describe("resolveConfig external database/nats URL detection", () => {
  it("treats a bracketed IPv6 loopback DATABASE_URL as local, not external", () => {
    const result = resolveConfig(flags, {
      DATABASE_URL: "postgres://[::1]:5432/postgres",
    });

    expect(result.externalDatabaseUrl).toBeNull();
  });

  it("treats a bracketed IPv6 loopback NATS_URL as local, not external", () => {
    const result = resolveConfig(flags, {
      NATS_URL: "nats://[::1]:4222",
    });

    expect(result.externalNatsUrl).toBeNull();
  });

  it("still treats a genuinely remote host as external", () => {
    const result = resolveConfig(flags, {
      DATABASE_URL: "postgres://db.example.com:5432/postgres",
    });

    expect(result.externalDatabaseUrl).toBe(
      "postgres://db.example.com:5432/postgres",
    );
  });
});

describe("resolveConfig NODE_ENV", () => {
  it("defaults to development when unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.nodeEnv).toBe("development");
  });

  it("accepts a valid NODE_ENV", () => {
    const result = resolveConfig(flags, { NODE_ENV: "production" });

    expect(result.settings.nodeEnv).toBe("production");
  });

  it("coerces an unrecognized NODE_ENV to development instead of passing it through", () => {
    const result = resolveConfig(flags, { NODE_ENV: "Production" });

    expect(result.settings.nodeEnv).toBe("development");
  });
});

describe("describeEncryptionKeyForLog", () => {
  it("reports the deterministic-fallback message when unset", () => {
    expect(describeEncryptionKeyForLog("")).toBe(
      "[settings] ENCRYPTION_KEY is not set (using deterministic fallback, 32 chars) — set ENCRYPTION_KEY for production",
    );
  });

  it("never includes the raw secret for a short key", () => {
    const message = describeEncryptionKeyForLog("shortkey");

    expect(message).not.toContain("shortkey");
    expect(message).toContain("***");
  });

  it("masks the middle of a long key, keeping only its edges", () => {
    const message = describeEncryptionKeyForLog(
      "a-much-longer-encryption-key-value",
    );

    expect(message).not.toContain("a-much-longer-encryption-key-value");
    expect(message).toBe(
      "[settings] ENCRYPTION_KEY is set (a-mu..alue, 34 chars)",
    );
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

  it("falls back to the computed default on a malformed override instead of skipping the drain", () => {
    expect(resolveShutdownDrainMs("api", forceExitMs, "not-a-number")).toBe(
      69_000,
    );
    expect(resolveShutdownDrainMs("api", forceExitMs, "-100")).toBe(69_000);
  });
});

describe("resolveConfig reports internal API env rename", () => {
  it("prefers the new REPORTS_INTERNAL_API_* names over the legacy CD names", () => {
    const result = resolveConfig(flags, {
      REPORTS_INTERNAL_API_URL: "https://reports-new.example.com",
      REPORTS_INTERNAL_API_KEY: "new-key",
      COMMERCE_DISCOVERY_INTERNAL_API_URL: "https://reports-old.example.com",
      COMMERCE_DISCOVERY_INTERNAL_API_KEY: "old-key",
    });

    expect(result.settings.reportsInternalApiUrl).toBe(
      "https://reports-new.example.com",
    );
    expect(result.settings.reportsInternalApiKey).toBe("new-key");
  });

  it("falls back to the legacy COMMERCE_DISCOVERY_INTERNAL_* names", () => {
    const result = resolveConfig(flags, {
      COMMERCE_DISCOVERY_INTERNAL_API_URL: "https://reports-old.example.com",
      COMMERCE_DISCOVERY_INTERNAL_API_KEY: "old-key",
    });

    expect(result.settings.reportsInternalApiUrl).toBe(
      "https://reports-old.example.com",
    );
    expect(result.settings.reportsInternalApiKey).toBe("old-key");
  });
});

describe("resolveConfig topup fee percent", () => {
  it("defaults to 15", () => {
    expect(resolveConfig(flags, {}).settings.topupFeePercent).toBe(15);
  });

  it("honors an override", () => {
    expect(
      resolveConfig(flags, { STUDIO_TOPUP_FEE_PERCENT: "20" }).settings
        .topupFeePercent,
    ).toBe(20);
  });

  it("rejects a non-numeric value at boot (fail-fast, not a silent default)", () => {
    expect(() =>
      resolveConfig(flags, { STUDIO_TOPUP_FEE_PERCENT: "free" }),
    ).toThrow("STUDIO_TOPUP_FEE_PERCENT must be a positive integer");
  });
});
