/**
 * Build an explicit, auditable environment for child server processes.
 *
 * Uses an allowlist of all Settings fields rather than inheriting the full
 * parent process.env. This ensures workers get the correct dynamically-
 * resolved values (e.g. embedded Postgres port in DATABASE_URL) and makes
 * the secret surface intentional and reviewable.
 *
 * POD_NAME is intentionally omitted so each worker generates its own UUID,
 * preventing NATS heartbeat KV collisions across workers.
 */

import type { Settings } from "../settings/types";

export function buildChildEnv(
  settings: Settings,
  extras: Record<string, string> = {},
): Record<string, string | undefined> {
  return {
    // Core
    PORT: String(settings.port),
    NODE_ENV: settings.nodeEnv,
    BASE_URL: settings.baseUrl,
    DATA_DIR: settings.dataDir,
    DECOCMS_HOME: settings.dataDir,

    // Database
    DATABASE_URL: settings.databaseUrl,
    DATABASE_PG_SSL: String(settings.databasePgSsl),
    DATABASE_POOL_MAX: String(settings.databasePoolMax),

    // NATS
    NATS_URL: settings.natsUrls.join(","),

    // Auth & secrets
    BETTER_AUTH_SECRET: settings.betterAuthSecret,
    ENCRYPTION_KEY: settings.encryptionKey,
    MESH_JWT_SECRET: settings.meshJwtSecret,
    DECOCMS_LOCAL_MODE: String(settings.localMode),
    DECOCMS_ALLOW_LOCAL_PROD: String(settings.allowLocalProd),
    DISABLE_RATE_LIMIT: String(settings.disableRateLimit),

    // Config files
    CONFIG_PATH: settings.configPath,
    AUTH_CONFIG_PATH: settings.authConfigPath,

    // Transport
    UNSAFE_ALLOW_STDIO_TRANSPORT: String(settings.unsafeAllowStdioTransport),

    // AI Gateway
    DECO_AI_GATEWAY_ENABLED: String(settings.aiGatewayEnabled),
    DECO_AI_GATEWAY_URL: settings.aiGatewayUrl,

    // Feature flags
    ENABLE_DECO_IMPORT: String(settings.enableDecoImport),

    // S3
    S3_ENDPOINT: settings.s3Endpoint,
    S3_BUCKET: settings.s3Bucket,
    S3_REGION: settings.s3Region,
    S3_ACCESS_KEY_ID: settings.s3AccessKeyId,
    S3_SECRET_ACCESS_KEY: settings.s3SecretAccessKey,
    S3_FORCE_PATH_STYLE: String(settings.s3ForcePathStyle),

    // Observability
    OTEL_SERVICE_NAME: settings.otelServiceName,
    CLICKHOUSE_URL: settings.clickhouseUrl,

    // External service credentials
    DECO_SUPABASE_URL: settings.decoSupabaseUrl,
    DECO_SUPABASE_SERVICE_KEY: settings.decoSupabaseServiceKey,

    // TLS: propagate custom CA certificates (e.g. RDS CA bundles)
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,

    // Runtime: workers suppress the Ink TUI and ASCII banner
    DECO_CLI: "1",
    DECO_NO_TUI: "true",

    // Caller-supplied overrides (e.g. DECOCMS_IS_WORKER, REUSE_PORT)
    ...extras,
  };
}
