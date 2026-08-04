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

describe("resolveConfig sandbox sticky head ref", () => {
  it("defaults to disabled when unset", () => {
    const result = resolveConfig(flags, {});
    expect(result.settings.sandboxStickyHeadRefEnabled).toBe(false);
  });

  it("enables via SANDBOX_STICKY_HEAD_REF=true", () => {
    const result = resolveConfig(flags, {
      SANDBOX_STICKY_HEAD_REF: "true",
    });
    expect(result.settings.sandboxStickyHeadRefEnabled).toBe(true);
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

describe("resolveConfig DBOS pool size", () => {
  it("defaults to 5 when unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.dbosPoolSize).toBe(5);
  });

  it("uses DBOS_POOL_SIZE when set", () => {
    const result = resolveConfig(flags, { DBOS_POOL_SIZE: "20" });

    expect(result.settings.dbosPoolSize).toBe(20);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid pool size %p",
    (value) => {
      expect(() => resolveConfig(flags, { DBOS_POOL_SIZE: value })).toThrow(
        "DBOS_POOL_SIZE must be a positive integer",
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

describe("resolveConfig duckdb threads", () => {
  it("defaults to undefined when unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.duckdbThreads).toBeUndefined();
  });

  it("uses DUCKDB_THREADS when set", () => {
    const result = resolveConfig(flags, { DUCKDB_THREADS: "4" });

    expect(result.settings.duckdbThreads).toBe(4);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid value %p",
    (value) => {
      expect(() => resolveConfig(flags, { DUCKDB_THREADS: value })).toThrow(
        "DUCKDB_THREADS must be a positive integer",
      );
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

describe("resolveConfig pod name", () => {
  it("generates a random id when POD_NAME is unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.podName).toBeTruthy();
  });

  it("falls back to a random id when POD_NAME is set to an empty string", () => {
    const result = resolveConfig(flags, { POD_NAME: "" });

    expect(result.settings.podName).toBeTruthy();
  });

  it("uses POD_NAME when set", () => {
    const result = resolveConfig(flags, { POD_NAME: "studio-worker-abc123" });

    expect(result.settings.podName).toBe("studio-worker-abc123");
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

  it("falls back to the legacy variables when the Studio ones are set to an empty string", () => {
    const result = resolveConfig(flags, {
      STUDIO_JWT_SECRET: "",
      MESH_JWT_SECRET: "legacy-secret",
      STUDIO_DISPATCH_ROLE: "",
      MESH_DISPATCH_ROLE: "worker",
    });

    expect(result.settings.studioJwtSecret).toBe("legacy-secret");
    expect(result.settings.dispatchRole).toBe("worker");
  });
});

describe("resolveConfig public URL", () => {
  it("prefers STUDIO_PUBLIC_URL over the legacy MESH_PUBLIC_URL alias", () => {
    const result = resolveConfig(flags, {
      STUDIO_PUBLIC_URL: "https://studio.example.com",
      MESH_PUBLIC_URL: "https://legacy.example.com",
    });

    expect(result.settings.publicUrl).toBe("https://studio.example.com");
  });

  it("accepts the legacy MESH_PUBLIC_URL during the compatibility window", () => {
    const result = resolveConfig(flags, {
      MESH_PUBLIC_URL: "https://legacy.example.com",
    });

    expect(result.settings.publicUrl).toBe("https://legacy.example.com");
  });

  it("falls back to MESH_PUBLIC_URL when STUDIO_PUBLIC_URL is an empty string", () => {
    const result = resolveConfig(flags, {
      STUDIO_PUBLIC_URL: "",
      MESH_PUBLIC_URL: "https://legacy.example.com",
    });

    expect(result.settings.publicUrl).toBe("https://legacy.example.com");
  });

  it("defaults to undefined when unset", () => {
    const result = resolveConfig(flags, {});

    expect(result.settings.publicUrl).toBeUndefined();
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

  it("falls back to the legacy CD names when the new ones are set to an empty string", () => {
    const result = resolveConfig(flags, {
      REPORTS_INTERNAL_API_URL: "",
      REPORTS_INTERNAL_API_KEY: "",
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
    ).toThrow("STUDIO_TOPUP_FEE_PERCENT must be a non-negative integer");
  });

  it("rejects a value above 100 instead of silently overcharging top-ups", () => {
    expect(() =>
      resolveConfig(flags, { STUDIO_TOPUP_FEE_PERCENT: "150" }),
    ).toThrow("STUDIO_TOPUP_FEE_PERCENT must be at most 100");
  });

  it("allows 0 to waive the fee entirely (self-hosted deployments)", () => {
    expect(
      resolveConfig(flags, { STUDIO_TOPUP_FEE_PERCENT: "0" }).settings
        .topupFeePercent,
    ).toBe(0);
  });
});

describe("resolveConfig decopilot max concurrent subagents", () => {
  it("defaults to 4", () => {
    expect(
      resolveConfig(flags, {}).settings.decopilotMaxConcurrentSubagents,
    ).toBe(4);
  });

  it("honors an override", () => {
    expect(
      resolveConfig(flags, { DECOPILOT_MAX_CONCURRENT_SUBAGENTS: "8" }).settings
        .decopilotMaxConcurrentSubagents,
    ).toBe(8);
  });

  it("rejects a non-numeric value at boot (fail-fast, not a silent default)", () => {
    expect(() =>
      resolveConfig(flags, { DECOPILOT_MAX_CONCURRENT_SUBAGENTS: "free" }),
    ).toThrow("DECOPILOT_MAX_CONCURRENT_SUBAGENTS must be a positive integer");
  });
});

describe("resolveConfig decopilot max concurrent hosted runs", () => {
  it("defaults to 3", () => {
    expect(
      resolveConfig(flags, {}).settings.decopilotMaxConcurrentHostedRuns,
    ).toBe(3);
  });

  it("honors an override", () => {
    expect(
      resolveConfig(flags, { DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS: "5" })
        .settings.decopilotMaxConcurrentHostedRuns,
    ).toBe(5);
  });

  it("rejects a non-numeric value at boot (fail-fast, not a silent default)", () => {
    expect(() =>
      resolveConfig(flags, { DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS: "free" }),
    ).toThrow(
      "DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS must be a positive integer",
    );
  });
});
