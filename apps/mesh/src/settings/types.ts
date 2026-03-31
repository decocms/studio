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
  allowLocalProd: boolean;
  disableRateLimit: boolean;

  // Observability
  clickhouseUrl: string | undefined;
  otelServiceName: string;

  // Event Bus & Networking
  natsUrls: string[];

  // Config files
  configPath: string;
  authConfigPath: string;

  // Transport
  unsafeAllowStdioTransport: boolean;

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
}

export interface ServiceOutputs {
  databaseUrl: string;
  natsUrls: string[];
}
