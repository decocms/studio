import { describe, expect, it } from "bun:test";
import { resolveConfig, resolveShutdownDrainMs } from "./resolve-config";
describe("resolveConfig agent sandbox availability", () => {
  it("defaults to disabled", () => {
    expect(resolveConfig({}).agentSandboxEnabled).toBe(false);
  });

  it.each(["true", "1"])("enables with %p", (value) => {
    const result = resolveConfig({
      STUDIO_AGENT_SANDBOX_ENABLED: value,
    });

    expect(result.agentSandboxEnabled).toBe(true);
  });

  it.each(["false", "0", "agent-sandbox", ""])(
    "stays disabled with %p",
    (value) => {
      const result = resolveConfig({
        STUDIO_AGENT_SANDBOX_ENABLED: value,
      });

      expect(result.agentSandboxEnabled).toBe(false);
    },
  );
});

describe("resolveConfig sandbox sticky head ref", () => {
  it("defaults to disabled when unset", () => {
    const result = resolveConfig({});
    expect(result.sandboxStickyHeadRefEnabled).toBe(false);
  });

  it("enables via SANDBOX_STICKY_HEAD_REF=true", () => {
    const result = resolveConfig({
      SANDBOX_STICKY_HEAD_REF: "true",
    });
    expect(result.sandboxStickyHeadRefEnabled).toBe(true);
  });
});

describe("resolveConfig NATS connection", () => {
  it("preserves an external URL and generic credentials file", () => {
    const result = resolveConfig({
      NATS_URL: "nats://nats.internal:4222",
      NATS_CREDS: "/run/secrets/studio.creds",
    });

    expect(result.natsUrls).toEqual(["nats://nats.internal:4222"]);
    expect(result.natsCredsPath).toBe("/run/secrets/studio.creds");
  });

  it("preserves account credentials without embedding them in server URLs", () => {
    const result = resolveConfig({
      NATS_URL: "nats://nats:4222",
      NATS_USER: "branch-a",
      NATS_PASSWORD: "synthetic-password",
    });
    expect(result.natsUrls).toEqual(["nats://nats:4222"]);
    expect(result.natsUser).toBe("branch-a");
    expect(result.natsPassword).toBe("synthetic-password");
  });

  it.each([
    { NATS_USER: "branch-a" },
    { NATS_PASSWORD: "synthetic-password" },
    { NATS_USER: "branch-a", NATS_PASSWORD: "" },
  ])("rejects incomplete account credentials %p", (env) => {
    expect(() => resolveConfig(env)).toThrow(
      "NATS_USER and NATS_PASSWORD must be set together",
    );
  });

  it("rejects ambiguous file and account credentials", () => {
    expect(() =>
      resolveConfig({
        NATS_CREDS: "/run/secrets/studio.creds",
        NATS_USER: "branch-a",
        NATS_PASSWORD: "synthetic-password",
      }),
    ).toThrow("Use either NATS_CREDS or NATS_USER/NATS_PASSWORD");
  });
});

describe("resolveConfig database pool max", () => {
  it("defaults to 5 when unset", () => {
    const result = resolveConfig({});

    expect(result.databasePoolMax).toBe(5);
  });

  it("uses DATABASE_POOL_MAX when set", () => {
    const result = resolveConfig({ DATABASE_POOL_MAX: "20" });

    expect(result.databasePoolMax).toBe(20);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid pool max %p",
    (value) => {
      expect(() => resolveConfig({ DATABASE_POOL_MAX: value })).toThrow(
        "DATABASE_POOL_MAX must be a positive integer",
      );
    },
  );
});

describe("resolveConfig DBOS pool size", () => {
  it("defaults to 5 when unset", () => {
    const result = resolveConfig({});

    expect(result.dbosPoolSize).toBe(5);
  });

  it("uses DBOS_POOL_SIZE when set", () => {
    const result = resolveConfig({ DBOS_POOL_SIZE: "20" });

    expect(result.dbosPoolSize).toBe(20);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid pool size %p",
    (value) => {
      expect(() => resolveConfig({ DBOS_POOL_SIZE: value })).toThrow(
        "DBOS_POOL_SIZE must be a positive integer",
      );
    },
  );
});

describe("resolveConfig port", () => {
  it("defaults to 3000 when unset", () => {
    const result = resolveConfig({});

    expect(result.port).toBe(3000);
  });

  it("uses PORT when set", () => {
    const result = resolveConfig({ PORT: "8080" });

    expect(result.port).toBe(8080);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid PORT %p",
    (value) => {
      expect(() => resolveConfig({ PORT: value })).toThrow(
        "PORT must be a positive integer",
      );
    },
  );

  it("throws for a PORT above 65535", () => {
    expect(() => resolveConfig({ PORT: "70000" })).toThrow(
      "PORT must be at most 65535",
    );
  });
});

describe("resolveConfig clickhouse max memory usage", () => {
  it("defaults to undefined when unset", () => {
    const result = resolveConfig({});

    expect(result.clickhouseMaxMemoryUsage).toBeUndefined();
  });

  it("uses CLICKHOUSE_MAX_MEMORY_USAGE when set", () => {
    const result = resolveConfig({
      CLICKHOUSE_MAX_MEMORY_USAGE: "1000000000",
    });

    expect(result.clickhouseMaxMemoryUsage).toBe(1000000000);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid value %p",
    (value) => {
      expect(() =>
        resolveConfig({ CLICKHOUSE_MAX_MEMORY_USAGE: value }),
      ).toThrow("CLICKHOUSE_MAX_MEMORY_USAGE must be a positive integer");
    },
  );
});

describe("resolveConfig duckdb threads", () => {
  it("defaults to undefined when unset", () => {
    const result = resolveConfig({});

    expect(result.duckdbThreads).toBeUndefined();
  });

  it("uses DUCKDB_THREADS when set", () => {
    const result = resolveConfig({ DUCKDB_THREADS: "4" });

    expect(result.duckdbThreads).toBe(4);
  });

  it.each(["abc", "0", "-1", "1.5", "Infinity"])(
    "throws for invalid value %p",
    (value) => {
      expect(() => resolveConfig({ DUCKDB_THREADS: value })).toThrow(
        "DUCKDB_THREADS must be a positive integer",
      );
    },
  );
});

describe("resolveConfig deployment admin emails", () => {
  it("defaults to an empty list when unset", () => {
    const result = resolveConfig({});

    expect(result.deploymentAdminEmails).toEqual([]);
  });

  it("normalizes case, whitespace, and trailing commas", () => {
    const result = resolveConfig({
      DEPLOYMENT_ADMIN_EMAILS: " Alice@Example.com, bob@example.com ,,",
    });

    expect(result.deploymentAdminEmails).toEqual([
      "alice@example.com",
      "bob@example.com",
    ]);
  });
});

describe("resolveConfig task board admin orgs", () => {
  it("defaults to an empty list — deployed is not enabled", () => {
    const result = resolveConfig({});

    expect(result.taskBoardAdminOrgIds).toEqual([]);
  });

  it("trims and drops blanks, and never touches case (org ids are exact)", () => {
    const result = resolveConfig({
      STUDIO_ADMIN_ORG_IDS: " Org_AbC , org_two ,,",
    });

    expect(result.taskBoardAdminOrgIds).toEqual(["Org_AbC", "org_two"]);
  });

  it("stays independent of the deployment admin allowlist", () => {
    const result = resolveConfig({
      DEPLOYMENT_ADMIN_EMAILS: "alice@example.com",
    });

    expect(result.taskBoardAdminOrgIds).toEqual([]);
  });
});

describe("resolveConfig pod name", () => {
  it("generates a random id when POD_NAME is unset", () => {
    const result = resolveConfig({});

    expect(result.podName).toBeTruthy();
  });

  it("falls back to a random id when POD_NAME is set to an empty string", () => {
    const result = resolveConfig({ POD_NAME: "" });

    expect(result.podName).toBeTruthy();
  });

  it("uses POD_NAME when set", () => {
    const result = resolveConfig({ POD_NAME: "studio-worker-abc123" });

    expect(result.podName).toBe("studio-worker-abc123");
  });
});

describe("resolveConfig Studio environment aliases", () => {
  it("prefers Studio JWT and dispatch variables", () => {
    const result = resolveConfig({
      STUDIO_JWT_SECRET: "studio-secret",
      MESH_JWT_SECRET: "legacy-secret",
      STUDIO_DISPATCH_ROLE: "api",
      MESH_DISPATCH_ROLE: "worker",
    });

    expect(result.studioJwtSecret).toBe("studio-secret");
    expect(result.dispatchRole).toBe("api");
  });

  it("accepts legacy variables during the compatibility window", () => {
    const result = resolveConfig({
      MESH_JWT_SECRET: "legacy-secret",
      MESH_DISPATCH_ROLE: "worker",
    });

    expect(result.studioJwtSecret).toBe("legacy-secret");
    expect(result.dispatchRole).toBe("worker");
  });

  it("falls back to the legacy variables when the Studio ones are set to an empty string", () => {
    const result = resolveConfig({
      STUDIO_JWT_SECRET: "",
      MESH_JWT_SECRET: "legacy-secret",
      STUDIO_DISPATCH_ROLE: "",
      MESH_DISPATCH_ROLE: "worker",
    });

    expect(result.studioJwtSecret).toBe("legacy-secret");
    expect(result.dispatchRole).toBe("worker");
  });
});

describe("resolveConfig public URL", () => {
  it("prefers STUDIO_PUBLIC_URL over the legacy MESH_PUBLIC_URL alias", () => {
    const result = resolveConfig({
      STUDIO_PUBLIC_URL: "https://studio.example.com",
      MESH_PUBLIC_URL: "https://legacy.example.com",
    });

    expect(result.publicUrl).toBe("https://studio.example.com");
  });

  it("accepts the legacy MESH_PUBLIC_URL during the compatibility window", () => {
    const result = resolveConfig({
      MESH_PUBLIC_URL: "https://legacy.example.com",
    });

    expect(result.publicUrl).toBe("https://legacy.example.com");
  });

  it("falls back to MESH_PUBLIC_URL when STUDIO_PUBLIC_URL is an empty string", () => {
    const result = resolveConfig({
      STUDIO_PUBLIC_URL: "",
      MESH_PUBLIC_URL: "https://legacy.example.com",
    });

    expect(result.publicUrl).toBe("https://legacy.example.com");
  });

  it("defaults to undefined when unset", () => {
    const result = resolveConfig({});

    expect(result.publicUrl).toBeUndefined();
  });
});

describe("resolveConfig NODE_ENV", () => {
  it("defaults to development when unset", () => {
    const result = resolveConfig({});

    expect(result.nodeEnv).toBe("development");
  });

  it("accepts a valid NODE_ENV", () => {
    const result = resolveConfig({ NODE_ENV: "production" });

    expect(result.nodeEnv).toBe("production");
  });

  it("coerces an unrecognized NODE_ENV to development instead of passing it through", () => {
    const result = resolveConfig({ NODE_ENV: "Production" });

    expect(result.nodeEnv).toBe("development");
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
    const result = resolveConfig({
      REPORTS_INTERNAL_API_URL: "https://reports-new.example.com",
      REPORTS_INTERNAL_API_KEY: "new-key",
      COMMERCE_DISCOVERY_INTERNAL_API_URL: "https://reports-old.example.com",
      COMMERCE_DISCOVERY_INTERNAL_API_KEY: "old-key",
    });

    expect(result.reportsInternalApiUrl).toBe(
      "https://reports-new.example.com",
    );
    expect(result.reportsInternalApiKey).toBe("new-key");
  });

  it("falls back to the legacy REPORTS_INTERNAL_* names", () => {
    const result = resolveConfig({
      COMMERCE_DISCOVERY_INTERNAL_API_URL: "https://reports-old.example.com",
      COMMERCE_DISCOVERY_INTERNAL_API_KEY: "old-key",
    });

    expect(result.reportsInternalApiUrl).toBe(
      "https://reports-old.example.com",
    );
    expect(result.reportsInternalApiKey).toBe("old-key");
  });

  it("falls back to the legacy CD names when the new ones are set to an empty string", () => {
    const result = resolveConfig({
      REPORTS_INTERNAL_API_URL: "",
      REPORTS_INTERNAL_API_KEY: "",
      COMMERCE_DISCOVERY_INTERNAL_API_URL: "https://reports-old.example.com",
      COMMERCE_DISCOVERY_INTERNAL_API_KEY: "old-key",
    });

    expect(result.reportsInternalApiUrl).toBe(
      "https://reports-old.example.com",
    );
    expect(result.reportsInternalApiKey).toBe("old-key");
  });
});

describe("resolveConfig task quota", () => {
  it("is dormant by default with the plan's limits", () => {
    const settings = resolveConfig({});
    expect(settings.taskQuotaEnforced).toBe(false);
    expect(settings.freeTaskExecutions).toBe(3);
    expect(settings.monthlyTaskExecutions).toBe(10);
  });

  it("honors overrides and rejects garbage at boot", () => {
    const settings = resolveConfig({
      STUDIO_TASK_QUOTA_ENFORCED: "true",
      STUDIO_FREE_TASKS: "5",
      STUDIO_MONTHLY_TASKS: "20",
    });
    expect(settings.taskQuotaEnforced).toBe(true);
    expect(settings.freeTaskExecutions).toBe(5);
    expect(settings.monthlyTaskExecutions).toBe(20);
    expect(() => resolveConfig({ STUDIO_FREE_TASKS: "many" })).toThrow(
      "STUDIO_FREE_TASKS must be a positive integer",
    );
  });
});

describe("resolveConfig topup fee percent", () => {
  it("defaults to 15", () => {
    expect(resolveConfig({}).topupFeePercent).toBe(15);
  });

  it("honors an override", () => {
    expect(
      resolveConfig({ STUDIO_TOPUP_FEE_PERCENT: "20" }).topupFeePercent,
    ).toBe(20);
  });

  it("rejects a non-numeric value at boot (fail-fast, not a silent default)", () => {
    expect(() => resolveConfig({ STUDIO_TOPUP_FEE_PERCENT: "free" })).toThrow(
      "STUDIO_TOPUP_FEE_PERCENT must be a non-negative integer",
    );
  });

  it("rejects a value above 100 instead of silently overcharging top-ups", () => {
    expect(() => resolveConfig({ STUDIO_TOPUP_FEE_PERCENT: "150" })).toThrow(
      "STUDIO_TOPUP_FEE_PERCENT must be at most 100",
    );
  });

  it("allows 0 to waive the fee entirely (self-hosted deployments)", () => {
    expect(
      resolveConfig({ STUDIO_TOPUP_FEE_PERCENT: "0" }).topupFeePercent,
    ).toBe(0);
  });
});

describe("resolveConfig decopilot max concurrent subagents", () => {
  it("defaults to 4", () => {
    expect(resolveConfig({}).decopilotMaxConcurrentSubagents).toBe(4);
  });

  it("honors an override", () => {
    expect(
      resolveConfig({ DECOPILOT_MAX_CONCURRENT_SUBAGENTS: "8" })
        .decopilotMaxConcurrentSubagents,
    ).toBe(8);
  });

  it("rejects a non-numeric value at boot (fail-fast, not a silent default)", () => {
    expect(() =>
      resolveConfig({ DECOPILOT_MAX_CONCURRENT_SUBAGENTS: "free" }),
    ).toThrow("DECOPILOT_MAX_CONCURRENT_SUBAGENTS must be a positive integer");
  });
});

describe("resolveConfig decopilot max concurrent hosted runs", () => {
  it("defaults to 3", () => {
    expect(resolveConfig({}).decopilotMaxConcurrentHostedRuns).toBe(3);
  });

  it("honors an override", () => {
    expect(
      resolveConfig({ DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS: "5" })
        .decopilotMaxConcurrentHostedRuns,
    ).toBe(5);
  });

  it("rejects a non-numeric value at boot (fail-fast, not a silent default)", () => {
    expect(() =>
      resolveConfig({ DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS: "free" }),
    ).toThrow(
      "DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS must be a positive integer",
    );
  });
});

describe("resolveConfig plans gateway JWT secret", () => {
  it("refuses to boot with plans on and no explicit gateway JWT secret", () => {
    expect(() =>
      resolveConfig({
        STUDIO_PLANS_ENABLED: "true",
        BETTER_AUTH_SECRET: "some-unrelated-session-secret",
      }),
    ).toThrow(/STUDIO_PLANS_ENABLED requires an explicit gateway JWT secret/);
  });

  it.each(["STUDIO_JWT_SECRET", "MESH_JWT_SECRET"])(
    "boots with plans on when %s is set",
    (name) => {
      const result = resolveConfig({
        STUDIO_PLANS_ENABLED: "true",
        DECO_AI_GATEWAY_ENABLED: "true",
        [name]: "shared-with-the-gateway",
        STUDIO_PROVISION_SECRET_KEY: "shared-service-key",
      });

      expect(result.studioJwtSecret).toBe("shared-with-the-gateway");
    },
  );

  it("refuses to boot with plans on and no provision key", () => {
    // Same consequence as a missing JWT secret: the gateway cannot identify
    // this server, falls back to a per-user membership callback that 401s for
    // anyone who never completed the gateway OAuth flow, and every gate then
    // fails OPEN. Only the JWT half had a check.
    expect(() =>
      resolveConfig({
        STUDIO_PLANS_ENABLED: "true",
        STUDIO_JWT_SECRET: "shared-with-the-gateway",
      }),
    ).toThrow(/requires STUDIO_PROVISION_SECRET_KEY/);
  });

  it("does not require it while plans are off — that path 401s loudly, it does not open a gate", () => {
    expect(() => resolveConfig({})).not.toThrow();
  });

  it("refuses to boot with plans on and the gateway disabled", () => {
    // The third door to a fleet-wide fail-open, and the one the chart's own
    // defaults lead to: `DECO_AI_GATEWAY_ENABLED` ships "false" and the plans
    // block never says to flip it. With no gateway there is no adapter to ask,
    // so `planStateFor` returns null and every gate allows.
    expect(() =>
      resolveConfig({
        STUDIO_PLANS_ENABLED: "true",
        STUDIO_JWT_SECRET: "shared-with-the-gateway",
        STUDIO_PROVISION_SECRET_KEY: "shared-service-key",
      }),
    ).toThrow(/requires DECO_AI_GATEWAY_ENABLED=true/);
  });

  it("refuses to boot when Stripe can sell a plan the gateway cannot be told about", () => {
    // The webhook is the only path to a paid tier and it places the tier
    // through the gateway's admin API. A price map with no admin token is a
    // card charged for an entitlement that cannot land.
    expect(() =>
      resolveConfig({
        STUDIO_PLANS_ENABLED: "true",
        DECO_AI_GATEWAY_ENABLED: "true",
        STUDIO_JWT_SECRET: "shared-with-the-gateway",
        STUDIO_PROVISION_SECRET_KEY: "shared-service-key",
        STRIPE_PLAN_PRICE_IDS: "price_abc=pro",
      }),
    ).toThrow(/DECO_AI_GATEWAY_ADMIN_TOKEN is not\./);
  });

  it("boots with the price map and the admin token together", () => {
    expect(() =>
      resolveConfig({
        STUDIO_PLANS_ENABLED: "true",
        DECO_AI_GATEWAY_ENABLED: "true",
        STUDIO_JWT_SECRET: "shared-with-the-gateway",
        STUDIO_PROVISION_SECRET_KEY: "shared-service-key",
        STRIPE_PLAN_PRICE_IDS: "price_abc=pro",
        DECO_AI_GATEWAY_ADMIN_TOKEN: "admin-token",
      }),
    ).not.toThrow();
  });

  it("treats an empty string as unset, so a rendered-but-blank template still fails the boot", () => {
    expect(() =>
      resolveConfig({
        STUDIO_PLANS_ENABLED: "true",
        STUDIO_JWT_SECRET: "",
        MESH_JWT_SECRET: "",
      }),
    ).toThrow(/STUDIO_PLANS_ENABLED requires an explicit gateway JWT secret/);
  });

  /**
   * The map that decides what a payment BUYS. A wrong entry here grants the
   * wrong tier, so anything unparseable is dropped rather than guessed at —
   * and an unmapped price then grants nothing (see planIdForStripe).
   */
  describe("STRIPE_PLAN_PRICE_IDS", () => {
    const parse = (raw: string | undefined) =>
      resolveConfig({ STRIPE_PLAN_PRICE_IDS: raw }).stripePlanPriceIds;

    it("maps each price to its plan", () => {
      expect(parse("price_a=pro,price_b=ultra")).toEqual({
        price_a: "pro",
        price_b: "ultra",
      });
    });

    it("tolerates whitespace and trailing separators", () => {
      expect(parse(" price_a = pro , price_b=ultra , ")).toEqual({
        price_a: "pro",
        price_b: "ultra",
      });
    });

    it("is empty when unset, so Stripe grants and revokes nothing", () => {
      expect(parse(undefined)).toEqual({});
      expect(parse("")).toEqual({});
    });

    it("drops an unparseable entry instead of failing the boot or guessing", () => {
      expect(parse("garbage,price_a=pro,=ultra,price_b=")).toEqual({
        price_a: "pro",
      });
    });
  });
});

describe("resolveConfig API key rate limit", () => {
  it("is off by default with 600 requests per minute", () => {
    const settings = resolveConfig({});
    expect(settings.apiKeyRateLimitMode).toBe("off");
    expect(settings.apiKeyRateLimitPerMinute).toBe(600);
  });

  it("honors overrides and rejects garbage at boot", () => {
    const settings = resolveConfig({
      API_KEY_RATE_LIMIT_MODE: "enforce",
      API_KEY_RATE_LIMIT_PER_MINUTE: "120",
    });
    expect(settings.apiKeyRateLimitMode).toBe("enforce");
    expect(settings.apiKeyRateLimitPerMinute).toBe(120);
    expect(() => resolveConfig({ API_KEY_RATE_LIMIT_MODE: "on" })).toThrow(
      "API_KEY_RATE_LIMIT_MODE must be off, observe or enforce",
    );
    expect(() => resolveConfig({ API_KEY_RATE_LIMIT_PER_MINUTE: "0" })).toThrow(
      "API_KEY_RATE_LIMIT_PER_MINUTE must be a positive integer",
    );
  });
});
