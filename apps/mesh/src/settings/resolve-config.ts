/**
 * Resolve raw inputs (CLI flags + env vars) into a validated config.
 *
 * Pure function — no side effects, no process.env mutations.
 */

import { homedir } from "os";
import type { CliFlags, Settings } from "./types";

function toBool(value: string | undefined): boolean {
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

  const settings: Omit<Settings, "databaseUrl" | "natsUrls"> = {
    // Core
    nodeEnv,
    port: Number(flags.port) || Number(envVars.PORT) || 3000,
    baseUrl: flags.baseUrl || envVars.BASE_URL,
    dataDir,

    // Database (url resolved after services start)
    databasePgSsl: toBool(envVars.DATABASE_PG_SSL),
    databasePoolMax: Number(envVars.DATABASE_POOL_MAX) || 3,

    // Auth & Secrets
    betterAuthSecret: envVars.BETTER_AUTH_SECRET || "",
    encryptionKey: envVars.ENCRYPTION_KEY || "",
    meshJwtSecret: envVars.MESH_JWT_SECRET,
    localMode,
    disableRateLimit: toBool(envVars.DISABLE_RATE_LIMIT),
    studioProvisionSecretKey: envVars.STUDIO_PROVISION_SECRET_KEY,

    // Observability
    clickhouseUrl: envVars.CLICKHOUSE_URL,
    otelServiceName: envVars.OTEL_SERVICE_NAME || "studio",

    // Config files
    configPath: envVars.CONFIG_PATH || "./config.json",

    // AI Gateway
    aiGatewayEnabled: toBool(envVars.DECO_AI_GATEWAY_ENABLED),
    aiGatewayUrl:
      envVars.DECO_AI_GATEWAY_URL || "https://ai-site.decocache.com",

    // Feature Flags
    enableDecoImport: toBool(envVars.ENABLE_DECO_IMPORT),

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

    // Runtime flags
    isCli: true,
    noTui: flags.noTui === true,
    podName: envVars.POD_NAME ?? crypto.randomUUID(),

    // External service credentials
    decoSupabaseUrl: envVars.DECO_SUPABASE_URL,
    decoSupabaseServiceKey: envVars.DECO_SUPABASE_SERVICE_KEY,
    firecrawlApiKey: envVars.FIRECRAWL_API_KEY,
  };

  return {
    settings,
    externalDatabaseUrl: externalUrlOrNull(envVars.DATABASE_URL),
    externalNatsUrl: externalUrlOrNull(natsRaw),
    skipMigrations: flags.skipMigrations,
  };
}
