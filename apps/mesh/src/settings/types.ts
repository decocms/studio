/**
 * Settings type definition for MCP Mesh.
 *
 * Constructed once by the startup pipeline, frozen, and available
 * via getSettings() for the lifetime of the process.
 */

export interface Settings {
  // Core
  nodeEnv: "production" | "development" | "test";
  port: number;
  baseUrl: string | undefined;
  dataDir: string;

  // Database
  databaseUrl: string;
  databasePgSsl: boolean;
  databasePoolMax: number;

  // Auth & Secrets
  betterAuthSecret: string;
  encryptionKey: string;
  meshJwtSecret: string | undefined;
  localMode: boolean;
  disableRateLimit: boolean;
  studioProvisionSecretKey: string | undefined; // Secret key to call the Deco AI Gateway API to provision keys

  // Observability
  // HTTP URL of the ClickHouse instance holding OTel-native telemetry tables
  // (otel_logs, otel_metrics_*). When set, the monitoring dashboard queries it
  // instead of the local NDJSON files via DuckDB.
  clickhouseUrl: string | undefined;
  // Dedicated OTLP collector base URL for monitoring/audit logs. Falls back to
  // OTEL_EXPORTER_OTLP_ENDPOINT (shared with infra logs) when unset. The "/v1/logs"
  // signal path is appended automatically.
  monitoringOtlpEndpoint: string | undefined;
  otelServiceName: string;

  // Event Bus & Networking
  natsUrls: string[];

  // Config files
  configPath: string;

  // AI Gateway
  aiGatewayEnabled: boolean;
  aiGatewayUrl: string;

  // Feature Flags
  enableDecoImport: boolean;

  // Object Storage (S3-compatible)
  s3Endpoint: string | undefined;
  s3Bucket: string | undefined;
  s3Region: string;
  s3AccessKeyId: string | undefined;
  s3SecretAccessKey: string | undefined;
  s3ForcePathStyle: boolean;

  // Runtime flags (set by CLI)
  isCli: boolean;
  noTui: boolean;
  podName: string;

  // External service credentials (optional)
  decoSupabaseUrl: string | undefined;
  decoSupabaseServiceKey: string | undefined;
  firecrawlApiKey: string | undefined;
}

export interface CliFlags {
  port: string;
  home: string;
  baseUrl?: string;
  localMode: boolean;
  skipMigrations: boolean;
  noTui?: boolean;
  vitePort?: string;
  nodeEnv?: "production" | "development" | "test";
}

export interface ServiceInputs {
  home: string;
  externalDatabaseUrl: string | null;
  externalNatsUrl: string | null;
  /**
   * When true, skip auto-provisioning MinIO (e.g. an external S3 store is
   * already configured via S3_* env). Defaults to provisioning MinIO.
   */
  skipMinio?: boolean;
}

export interface ServiceOutputs {
  databaseUrl: string;
  natsUrls: string[];
  /**
   * S3 object-storage config for the managed/external store, if any. Null when
   * object storage is not configured (no managed MinIO, no external S3 env).
   * Threaded into the frozen Settings so the in-process serve path resolves the
   * real S3Service; also mirrored into process.env for spawned child servers.
   */
  s3: {
    endpoint: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    /** true for managed MinIO; reflects operator's S3_FORCE_PATH_STYLE for external S3. */
    forcePathStyle: boolean;
  } | null;
}
