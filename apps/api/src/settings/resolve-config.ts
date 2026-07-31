/**
 * Resolve raw inputs (CLI flags + env vars) into a validated config.
 *
 * Pure function — no side effects, no process.env mutations.
 */

import { homedir } from "os";
import type { CliFlags, DispatchRole, Settings } from "./types";

type SandboxProviderKind = Settings["sandboxProviderKind"];

const DISPATCH_ROLES = new Set<DispatchRole>(["all", "worker", "api"]);

/** Normalize `STUDIO_DISPATCH_ROLE`; anything unknown coerces to safe "all". */
function resolveDispatchRole(raw: string | undefined): DispatchRole {
  const role = (raw ?? "").trim();
  return DISPATCH_ROLES.has(role as DispatchRole)
    ? (role as DispatchRole)
    : "all";
}

const NODE_ENVS = new Set<Settings["nodeEnv"]>([
  "production",
  "development",
  "test",
]);

/**
 * Normalize `NODE_ENV`; anything unknown coerces to safe "development" rather
 * than silently flowing an unvalidated string into `nodeEnv === "production"`
 * checks that gate production-only behavior (e.g. sandbox `isProduction`).
 */
function resolveNodeEnv(raw: string | undefined): Settings["nodeEnv"] {
  const value = (raw ?? "").trim();
  return NODE_ENVS.has(value as Settings["nodeEnv"])
    ? (value as Settings["nodeEnv"])
    : "development";
}

// The shutdown drain only exists to outlast NLB ip-target deregistration of the
// frontdoor HTTP listener. "worker" pods aren't frontdoor targets (no
// `decocms.com/frontdoor` label), so draining just steals the grace budget
// DBOS.shutdown() needs to drain in-flight runs — skip it. `SHUTDOWN_DRAIN_MS`
// overrides either way.
export function resolveShutdownDrainMs(
  role: DispatchRole,
  forceExitMs: number,
  envOverride: string | undefined,
): number {
  const fallback = role === "worker" ? 0 : Math.floor(forceExitMs * 0.6);
  if (envOverride === undefined || envOverride === "") return fallback;
  // A malformed override must fall back to the computed default rather than
  // silently becoming 0 (NaN/negative both collapse to a 0ms sleep) — that
  // would skip the drain this function exists for and reintroduce the CF 520s
  // described above.
  const value = Number(envOverride);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Startup log line for `ENCRYPTION_KEY` — reports whether it's set and how
 * long it is (useful for spotting misconfiguration) WITHOUT leaking the
 * actual secret into stdout/log aggregators.
 */
export function describeEncryptionKeyForLog(ek: string): string {
  if (!ek) {
    return "[settings] ENCRYPTION_KEY is not set (using deterministic fallback, 32 chars) — set ENCRYPTION_KEY for production";
  }
  const masked = ek.length <= 8 ? "***" : `${ek.slice(0, 4)}..${ek.slice(-4)}`;
  return `[settings] ENCRYPTION_KEY is set (${masked}, ${ek.length} chars)`;
}

function toBool(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function toBoolOrUndefined(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return toBool(value);
}

function toPositiveIntegerOrUndefined(
  name: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined || value === "") return undefined;

  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return numberValue;
}

function toPositiveIntegerOrDefault(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  return toPositiveIntegerOrUndefined(name, value) ?? defaultValue;
}

/** Tri-state flag: unset/empty → `fallback`, otherwise parse as boolean. */
function toBoolWithDefault(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

/**
 * Determine if a URL points to a non-local host (i.e., an external service).
 * Returns the URL string if external, null if local or not set.
 */
export function externalUrlOrNull(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    // `URL#hostname` keeps the brackets for a bracketed IPv6 host (e.g.
    // "[::1]"), so strip them before comparing against the bare loopback form.
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/**
 * Whether S3 access should force path-style addressing. Unset/empty defaults
 * to path-style (needed by custom S3-compatible stores like MinIO/Ceph); real
 * AWS S3 (virtual-hosted-style) must set S3_FORCE_PATH_STYLE=false. Shared
 * with `ensure-services.ts`'s external-S3 branch so the in-process
 * `buildSettings` path and the bundled-prod `initSettingsFromEnv` path agree.
 */
export function resolveS3ForcePathStyle(raw: string | undefined): boolean {
  return raw === undefined || raw === "" || raw === "true" || raw === "1";
}

const SANDBOX_PROVIDER_KINDS = new Set<SandboxProviderKind>([
  "agent-sandbox",
  "user-desktop",
]);
type LegacySandboxProviderKind = SandboxProviderKind | "cluster";

function resolveSandboxProviderKind(
  raw: string | undefined,
): SandboxProviderKind {
  const trimmed = (raw ?? "").trim();
  const kind = (trimmed.length > 0 ? trimmed : "user-desktop") as
    | LegacySandboxProviderKind
    | string;
  if (kind === "cluster") return "agent-sandbox";
  if (!SANDBOX_PROVIDER_KINDS.has(kind as SandboxProviderKind)) {
    throw new Error(
      `Unknown STUDIO_SANDBOX_PROVIDER="${raw}" — expected "agent-sandbox", legacy "cluster", or "user-desktop".`,
    );
  }
  return kind as SandboxProviderKind;
}

export interface ResolvedConfig {
  settings: Omit<Settings, "databaseUrl" | "natsUrls">;
  externalDatabaseUrl: string | null;
  externalNatsUrl: string | null;
  skipMigrations: boolean;
}

export function resolveConfig(
  flags: CliFlags,
  envVars: Record<string, string | undefined>,
): ResolvedConfig {
  const dataDir =
    flags.home ||
    envVars.DATA_DIR ||
    envVars.DECOCMS_HOME ||
    `${homedir()}/deco`;

  const localMode = flags.localMode;
  const nodeEnv: Settings["nodeEnv"] =
    flags.nodeEnv || resolveNodeEnv(envVars.NODE_ENV);

  const natsRaw = envVars.NATS_URL || "nats://localhost:4222";
  const natsTunnelPublicEnabled =
    toBoolOrUndefined(envVars.NATS_TUNNEL_PUBLIC_ENABLED) ??
    !!envVars.NATS_PUBLIC_URL;

  const settings: Omit<Settings, "databaseUrl" | "natsUrls"> = {
    // Core
    nodeEnv,
    port: toPositiveIntegerOrDefault("PORT", flags.port || envVars.PORT, 3000),
    baseUrl: flags.baseUrl || envVars.BASE_URL,
    publicUrl: envVars.STUDIO_PUBLIC_URL ?? envVars.MESH_PUBLIC_URL,
    dataDir,

    // Database (url resolved after services start)
    databasePgSsl: toBool(envVars.DATABASE_PG_SSL),
    databasePoolMax: toPositiveIntegerOrDefault(
      "DATABASE_POOL_MAX",
      envVars.DATABASE_POOL_MAX,
      5,
    ),
    dbosPoolSize: toPositiveIntegerOrDefault(
      "DBOS_POOL_SIZE",
      envVars.DBOS_POOL_SIZE,
      5,
    ),

    // Auth & Secrets
    betterAuthSecret: envVars.BETTER_AUTH_SECRET || "",
    encryptionKey: envVars.ENCRYPTION_KEY || "",
    studioJwtSecret: envVars.STUDIO_JWT_SECRET ?? envVars.MESH_JWT_SECRET,
    localMode,
    disableRateLimit: toBool(envVars.DISABLE_RATE_LIMIT),
    studioProvisionSecretKey: envVars.STUDIO_PROVISION_SECRET_KEY,
    deploymentAdminEmails: (envVars.DEPLOYMENT_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),

    // Observability
    clickhouseUrl: envVars.CLICKHOUSE_URL,
    clickhouseMaxMemoryUsage: toPositiveIntegerOrUndefined(
      "CLICKHOUSE_MAX_MEMORY_USAGE",
      envVars.CLICKHOUSE_MAX_MEMORY_USAGE,
    ),
    monitoringOtlpEndpoint: envVars.MONITORING_OTLP_ENDPOINT,
    otelServiceName: envVars.OTEL_SERVICE_NAME || "studio",

    // Event Bus & Networking
    natsPublicUrl: envVars.NATS_PUBLIC_URL,
    natsTunnelPublicEnabled,
    natsTunnelSessionTtlSeconds: toPositiveIntegerOrDefault(
      "NATS_TUNNEL_SESSION_TTL_SECONDS",
      envVars.NATS_TUNNEL_SESSION_TTL_SECONDS,
      900,
    ),
    natsOperatorJwt: envVars.NATS_OPERATOR_JWT,
    natsAccountJwt: envVars.NATS_ACCOUNT_JWT,
    natsAccountSigningKey: envVars.NATS_ACCOUNT_SIGNING_KEY,
    natsCredsPath: envVars.NATS_CREDS,

    // Config files
    configPath: envVars.CONFIG_PATH || "./config.json",

    // AI Gateway
    aiGatewayEnabled: toBool(envVars.DECO_AI_GATEWAY_ENABLED),
    aiGatewayUrl: envVars.DECO_AI_GATEWAY_URL || "https://ai-site.deco.site",
    aiGatewayAdminToken: envVars.DECO_AI_GATEWAY_ADMIN_TOKEN,
    seatAllowanceCents: toPositiveIntegerOrDefault(
      "STUDIO_SEAT_ALLOWANCE_CENTS",
      envVars.STUDIO_SEAT_ALLOWANCE_CENTS,
      500,
    ),
    stripeWebhookSecret: envVars.STRIPE_WEBHOOK_SECRET,
    stripeSecretKey: envVars.STRIPE_SECRET_KEY,
    stripeSeatPriceId: envVars.STRIPE_SEAT_PRICE_ID,
    topupFeePercent: toPositiveIntegerOrDefault(
      "STUDIO_TOPUP_FEE_PERCENT",
      envVars.STUDIO_TOPUP_FEE_PERCENT,
      15,
    ),

    // Feature Flags
    enableDecoImport: toBool(envVars.ENABLE_DECO_IMPORT),
    billingEnforced: toBool(envVars.STUDIO_BILLING_ENFORCED),
    // MCP caching is on by default in production, off in development. Set
    // MCP_CACHE_ENABLED=false to disable in prod, =true to enable in dev.
    mcpCacheEnabled: toBoolWithDefault(
      envVars.MCP_CACHE_ENABLED,
      nodeEnv !== "development",
    ),
    orgFsPublicSetsJson: envVars.ORGFS_PUBLIC_SETS,
    orgFsMountsDisabled: toBool(envVars.DISABLE_ORGFS_MOUNTS),
    decopilotMaxConcurrentSubagents: toPositiveIntegerOrDefault(
      "DECOPILOT_MAX_CONCURRENT_SUBAGENTS",
      envVars.DECOPILOT_MAX_CONCURRENT_SUBAGENTS,
      4,
    ),
    decopilotMaxConcurrentHostedRuns: toPositiveIntegerOrDefault(
      "DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS",
      envVars.DECOPILOT_MAX_CONCURRENT_HOSTED_RUNS,
      3,
    ),
    // Object Storage (S3-compatible)
    s3Endpoint: envVars.S3_ENDPOINT,
    s3Bucket: envVars.S3_BUCKET,
    s3Region: envVars.S3_REGION || "auto",
    s3AccessKeyId: envVars.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: envVars.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: resolveS3ForcePathStyle(envVars.S3_FORCE_PATH_STYLE),

    // Monitoring object storage (OTLP-JSON over GCS). Raw env passthrough;
    // fallback to s3* is applied at the context-factory consumption point.
    monitoringS3Bucket: envVars.MONITORING_S3_BUCKET,
    monitoringS3Endpoint: envVars.MONITORING_S3_ENDPOINT,
    monitoringS3Region: envVars.MONITORING_S3_REGION,
    monitoringS3AccessKeyId: envVars.MONITORING_S3_ACCESS_KEY_ID,
    monitoringS3SecretAccessKey: envVars.MONITORING_S3_SECRET_ACCESS_KEY,
    monitoringS3Prefix: envVars.MONITORING_S3_PREFIX,
    duckdbExtensionDirectory:
      envVars.DUCKDB_EXTENSION_DIRECTORY || "/opt/duckdb/extensions",
    duckdbMemoryLimit: envVars.DUCKDB_MEMORY_LIMIT || undefined,
    duckdbThreads: envVars.DUCKDB_THREADS
      ? Number(envVars.DUCKDB_THREADS)
      : undefined,

    // Runtime flags
    isCli: true,
    noTui: flags.noTui === true,
    podName: envVars.POD_NAME ?? crypto.randomUUID(),
    dispatchRole: resolveDispatchRole(
      envVars.STUDIO_DISPATCH_ROLE ?? envVars.MESH_DISPATCH_ROLE,
    ),
    sandboxProviderKind: resolveSandboxProviderKind(
      envVars.STUDIO_SANDBOX_PROVIDER,
    ),

    // External service credentials
    decoSupabaseUrl: envVars.DECO_SUPABASE_URL,
    decoSupabaseServiceKey: envVars.DECO_SUPABASE_SERVICE_KEY,
    firecrawlApiKey: envVars.FIRECRAWL_API_KEY,
    // New name first, legacy Commerce Discovery envs as fallback — one
    // setting, so prod migrates secrets whenever convenient without a
    // coordinated deploy. Drop the fallback once the CD envs are renamed.
    reportsInternalApiUrl:
      envVars.REPORTS_INTERNAL_API_URL ??
      envVars.COMMERCE_DISCOVERY_INTERNAL_API_URL,
    reportsInternalApiKey:
      envVars.REPORTS_INTERNAL_API_KEY ??
      envVars.COMMERCE_DISCOVERY_INTERNAL_API_KEY,

    // Managed asset storage (shared deco tenant bucket). Defaults match the
    // legacy admin platform so an existing deployment works without new env.
    s3TenantBucket: envVars.S3_TENANT_BUCKET || "new-deco-sites-assets",
    s3TenantRegion: envVars.S3_TENANT_REGION || "us-west-2",
    // No default: for real AWS the SDK derives the endpoint from region (so the
    // two can't drift). Set S3_TENANT_ENDPOINT only for a non-AWS S3 store.
    s3TenantEndpoint: envVars.S3_TENANT_ENDPOINT,
    s3TenantPublicUrlBase:
      envVars.S3_TENANT_PUBLIC_URL_BASE || "https://decoims.com",
    awsS3TenantRoleArn: envVars.AWS_S3_TENANT_ROLE_ARN,
    awsS3TenantProvisionerAccessKeyId:
      envVars.AWS_S3_TENANT_PROVISIONER_ACCESS_KEY_ID,
    awsS3TenantProvisionerSecretAccessKey:
      envVars.AWS_S3_TENANT_PROVISIONER_SECRET_ACCESS_KEY,
  };

  return {
    settings,
    externalDatabaseUrl: externalUrlOrNull(envVars.DATABASE_URL),
    externalNatsUrl: externalUrlOrNull(natsRaw),
    skipMigrations: flags.skipMigrations,
  };
}
