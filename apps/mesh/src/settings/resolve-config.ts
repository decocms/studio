/**
 * Resolve raw inputs (CLI flags + env vars) into a validated config.
 *
 * Pure function — no side effects, no process.env mutations.
 */

import { homedir } from "os";
import type { CliFlags, DispatchRole, Settings } from "./types";

type SandboxProviderKind = Settings["sandboxProviderKind"];

const DISPATCH_ROLES = new Set<DispatchRole>(["all", "worker", "api"]);

/** Normalize `MESH_DISPATCH_ROLE`; anything unknown coerces to the safe "all". */
function resolveDispatchRole(raw: string | undefined): DispatchRole {
  const role = (raw ?? "").trim();
  return DISPATCH_ROLES.has(role as DispatchRole)
    ? (role as DispatchRole)
    : "all";
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
  return Number(
    envOverride ?? (role === "worker" ? 0 : Math.floor(forceExitMs * 0.6)),
  );
}

function toBool(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

function toBoolOrUndefined(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return toBool(value);
}

function toPositiveIntegerOrDefault(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined || value === "") return defaultValue;

  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return numberValue;
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
function externalUrlOrNull(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

const SANDBOX_PROVIDER_KINDS = new Set<SandboxProviderKind>([
  "agent-sandbox",
  "user-desktop",
]);
type LegacySandboxProviderKind = SandboxProviderKind | "cluster";

function resolveSandboxProviderKind(
  raw: string | undefined,
): SandboxProviderKind {
  const kind = (raw && raw.length > 0 ? raw : "user-desktop") as
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
    flags.nodeEnv || (envVars.NODE_ENV as Settings["nodeEnv"]) || "development";

  const natsRaw = envVars.NATS_URL || "nats://localhost:4222";
  const natsTunnelPublicEnabled =
    toBoolOrUndefined(envVars.NATS_TUNNEL_PUBLIC_ENABLED) ??
    !!envVars.NATS_PUBLIC_URL;

  const settings: Omit<Settings, "databaseUrl" | "natsUrls"> = {
    // Core
    nodeEnv,
    port: Number(flags.port) || Number(envVars.PORT) || 3000,
    baseUrl: flags.baseUrl || envVars.BASE_URL,
    dataDir,

    // Database (url resolved after services start)
    databasePgSsl: toBool(envVars.DATABASE_PG_SSL),
    databasePoolMax: Number(envVars.DATABASE_POOL_MAX) || 5,

    // Auth & Secrets
    betterAuthSecret: envVars.BETTER_AUTH_SECRET || "",
    encryptionKey: envVars.ENCRYPTION_KEY || "",
    meshJwtSecret: envVars.MESH_JWT_SECRET,
    localMode,
    disableRateLimit: toBool(envVars.DISABLE_RATE_LIMIT),
    studioProvisionSecretKey: envVars.STUDIO_PROVISION_SECRET_KEY,
    deploymentAdminEmails: (envVars.DEPLOYMENT_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),

    // Observability
    clickhouseUrl: envVars.CLICKHOUSE_URL,
    clickhouseMaxMemoryUsage:
      Number(envVars.CLICKHOUSE_MAX_MEMORY_USAGE) || undefined,
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

    // Object Storage (S3-compatible)
    s3Endpoint: envVars.S3_ENDPOINT,
    s3Bucket: envVars.S3_BUCKET,
    s3Region: envVars.S3_REGION || "auto",
    s3AccessKeyId: envVars.S3_ACCESS_KEY_ID,
    s3SecretAccessKey: envVars.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle:
      envVars.S3_FORCE_PATH_STYLE === undefined ||
      envVars.S3_FORCE_PATH_STYLE === "" ||
      envVars.S3_FORCE_PATH_STYLE === "true" ||
      envVars.S3_FORCE_PATH_STYLE === "1",

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
    dispatchRole: resolveDispatchRole(envVars.MESH_DISPATCH_ROLE),
    sandboxProviderKind: resolveSandboxProviderKind(
      envVars.STUDIO_SANDBOX_PROVIDER,
    ),

    // External service credentials
    decoSupabaseUrl: envVars.DECO_SUPABASE_URL,
    decoSupabaseServiceKey: envVars.DECO_SUPABASE_SERVICE_KEY,
    firecrawlApiKey: envVars.FIRECRAWL_API_KEY,
    commerceDiscoveryInternalApiUrl:
      envVars.COMMERCE_DISCOVERY_INTERNAL_API_URL,
    commerceDiscoveryInternalApiKey:
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
