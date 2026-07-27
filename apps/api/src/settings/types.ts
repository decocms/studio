/**
 * Settings type definition for Studio.
 *
 * Constructed once by the startup pipeline, frozen, and available
 * via getSettings() for the lifetime of the process.
 */

/** Pod dispatch role — selects which DBOS run queues a pod dequeues. */
export type DispatchRole = "all" | "worker" | "api";

export interface Settings {
  // Core
  nodeEnv: "production" | "development" | "test";
  port: number;
  baseUrl: string | undefined;
  /** Externally reachable URL (STUDIO_PUBLIC_URL, legacy MESH_PUBLIC_URL alias)
   *  for URLs that must resolve from outside the cluster (e.g. the MCP
   *  endpoint handed to a remote link daemon). Falls back to baseUrl when unset. */
  publicUrl: string | undefined;
  dataDir: string;

  // Database
  databaseUrl: string;
  databasePgSsl: boolean;
  databasePoolMax: number;

  // Auth & Secrets
  betterAuthSecret: string;
  encryptionKey: string;
  studioJwtSecret: string | undefined;
  localMode: boolean;
  disableRateLimit: boolean;
  studioProvisionSecretKey: string | undefined; // Secret key to call the Deco AI Gateway API to provision keys
  /** Lowercased emails allowed onto the /admin instance dashboard (DEPLOYMENT_ADMIN_EMAILS, CSV). */
  deploymentAdminEmails: string[];

  // Observability
  // HTTP URL of the ClickHouse instance holding the OTel-native `otel_logs`
  // table. When set, the monitoring dashboard queries it (logs AND metrics are
  // derived from those rows) instead of the local NDJSON files via DuckDB.
  // Traces/metrics tables are not read.
  clickhouseUrl: string | undefined;
  // Per-query memory ceiling (bytes) sent as ClickHouse `max_memory_usage`.
  // The monitoring queries read the wide `LogAttributes` map, so the default
  // must be generous; tune down only on a memory-constrained ClickHouse.
  clickhouseMaxMemoryUsage: number | undefined;
  // Dedicated OTLP collector base URL for monitoring/audit logs. Falls back to
  // OTEL_EXPORTER_OTLP_ENDPOINT (shared with infra logs) when unset. The "/v1/logs"
  // signal path is appended automatically.
  monitoringOtlpEndpoint: string | undefined;
  otelServiceName: string;

  // Event Bus & Networking
  natsUrls: string[];
  natsPublicUrl: string | undefined;
  natsTunnelPublicEnabled: boolean;
  natsTunnelSessionTtlSeconds: number;
  natsOperatorJwt: string | undefined;
  natsAccountJwt: string | undefined;
  natsAccountSigningKey: string | undefined;
  /**
   * Path to a NATS creds file the CLUSTER authenticates with on its own
   * connection. Optional and backward-compatible: when unset the cluster
   * connects anonymously (production: anonymous to the internal listener). Set
   * by dev ensure-services because local NATS runs in operator mode, where
   * anonymous connect is impossible.
   */
  natsCredsPath: string | undefined;

  // Config files
  configPath: string;

  // AI Gateway
  aiGatewayEnabled: boolean;
  aiGatewayUrl: string;
  /** Bearer for the gateway's /api/admin/* (allowance grants). Absent →
   *  benefit sync is skipped (self-hosted deployments have no gateway admin). */
  aiGatewayAdminToken: string | undefined;
  /** Monthly AI-gateway allowance per PAID SEAT, in cents (default $5). */
  seatAllowanceCents: number;

  // Stripe (per-seat self-serve billing). Absent → the webhook route 503s and
  // no checkout can be created; invoiced/legacy orgs are unaffected.
  stripeWebhookSecret: string | undefined;
  stripeSecretKey: string | undefined;
  /** The $20/seat/month multi-currency price (created in the Stripe
   *  dashboard); quantity = the org's paid-seat count. */
  stripeSeatPriceId: string | undefined;
  /** Fee on AI-credit top-ups, percent (default 15 — parity with the
   *  gateway's legacy checkout being migrated off). */
  topupFeePercent: number;

  // Feature Flags
  enableDecoImport: boolean;
  /** Per-seat billing enforcement (STUDIO_BILLING_ENFORCED). Default OFF —
   *  self-hosted deployments never turn this on; with it off, every member
   *  behaves as a paid seat and billing tables are inert. */
  billingEnforced: boolean;
  /** MCP read/list caching. On by default in production, off in development;
   *  MCP_CACHE_ENABLED explicitly overrides either default. */
  mcpCacheEnabled: boolean;
  /** JSON array of public skill-set sources overlaid on the built-in
   *  defaults (see file-storage/public-sets.ts). */
  orgFsPublicSetsJson: string | undefined;
  /** Debug escape hatch: skip provisioning org-fs mounts into sandboxes
   *  (DISABLE_ORGFS_MOUNTS). org-fs is otherwise always mounted; this is
   *  for low-level mount debugging, not a supported org-fs-off mode. */
  orgFsMountsDisabled: boolean;
  // Object Storage (S3-compatible)
  s3Endpoint: string | undefined;
  s3Bucket: string | undefined;
  s3Region: string;
  s3AccessKeyId: string | undefined;
  s3SecretAccessKey: string | undefined;
  s3ForcePathStyle: boolean;

  // Monitoring object storage (OTLP-JSON over GCS S3-compatible endpoint).
  // When monitoringS3Bucket is set and clickhouseUrl is not, the dashboard reads
  // OTLP-JSON log files from this bucket via embedded DuckDB + httpfs. Endpoint /
  // region / credentials fall back to the matching s3* value when unset.
  monitoringS3Bucket: string | undefined;
  monitoringS3Endpoint: string | undefined;
  monitoringS3Region: string | undefined;
  monitoringS3AccessKeyId: string | undefined;
  monitoringS3SecretAccessKey: string | undefined;
  monitoringS3Prefix: string | undefined;
  // Absolute path to the DuckDB extension directory baked into the image
  // (contains httpfs). Required for the GCS OTLP monitoring path.
  duckdbExtensionDirectory: string | undefined;
  // Optional memory tuning for the embedded DuckDB monitoring engine on
  // memory-constrained containers. memory_limit (e.g. "2GB") and thread count;
  // unset → DuckDB defaults (80% RAM / all CPUs). The engine always spills to a
  // temp dir and disables insertion-order preservation regardless.
  duckdbMemoryLimit: string | undefined;
  duckdbThreads: number | undefined;

  // Runtime flags (set by CLI)
  isCli: boolean;
  noTui: boolean;
  podName: string;
  /** Which DBOS run queues this pod dequeues (pod dispatch-role split). */
  dispatchRole: DispatchRole;
  sandboxProviderKind: "agent-sandbox" | "user-desktop";

  // External service credentials (optional)
  decoSupabaseUrl: string | undefined;
  decoSupabaseServiceKey: string | undefined;
  firecrawlApiKey: string | undefined;
  /** Reports service internal API (the service historically named "Commerce
   *  Discovery" — REPORTS_INTERNAL_API_URL, with the legacy
   *  COMMERCE_DISCOVERY_INTERNAL_API_URL env still honored as fallback). */
  reportsInternalApiUrl: string | undefined;
  reportsInternalApiKey: string | undefined;

  // Managed asset storage (the shared deco tenant bucket). Used by `managed`
  // file configs: studio mints prefix-scoped STS credentials per site slug via
  // AssumeRole on `awsS3TenantRoleArn`, served through the CDN at
  // `s3TenantPublicUrlBase`. The provisioner key pair is OPTIONAL — when unset
  // the STS client uses the AWS default provider chain (the cluster's ambient
  // role). `awsS3TenantRoleArn` is required for the `managed` strategy to work.
  s3TenantBucket: string;
  s3TenantRegion: string;
  // Custom S3 endpoint — leave unset for real AWS (the SDK derives it from
  // region, keeping endpoint and region in sync); set only for an S3-compatible
  // tenant store (R2, MinIO, GCS).
  s3TenantEndpoint: string | undefined;
  s3TenantPublicUrlBase: string;
  awsS3TenantRoleArn: string | undefined;
  awsS3TenantProvisionerAccessKeyId: string | undefined;
  awsS3TenantProvisionerSecretAccessKey: string | undefined;
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
   * Dev NATS operator/JWT config for the link tunnel, when a managed
   * operator-mode NATS was provisioned. Null when NATS is external (production)
   * or not provisioned. Threaded into the frozen Settings so the in-process
   * serve path mints real session creds; also mirrored into process.env so a
   * spawned `dev:servers` child re-derives the same config.
   */
  natsTunnel: {
    /** Public URL handed to the daemon (dev: the TCP `nats://` URL). */
    publicUrl: string;
    /** Tunnel account JWT (NATS_ACCOUNT_JWT). */
    accountJwt: string;
    /** Tunnel account signing-key seed (NATS_ACCOUNT_SIGNING_KEY). */
    accountSigningKey: string;
    /** Operator JWT (NATS_OPERATOR_JWT). */
    operatorJwt: string;
    /** Absolute path to the cluster creds file (NATS_CREDS). */
    credsPath: string;
  } | null;
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
