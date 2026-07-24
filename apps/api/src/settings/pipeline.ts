/**
 * Settings startup pipeline.
 *
 * Runs the full initialization sequence:
 *   1. Snapshot process.env (Bun already loaded .env)
 *   2. Resolve config from CLI flags + env vars
 *   3. Start services if needed (pure, no process.env side effects)
 *   4. Run migrations
 *   5. Freeze and store Settings
 */

import type { CliFlags, Settings } from "./types";
import { describeEncryptionKeyForLog, resolveConfig } from "./resolve-config";
import { setGlobalSettings } from "./index";

export interface BuildResult {
  settings: Settings;
  services: Array<{ name: string; port: number }>;
  /** Names of services that this process spawned (owner === "managed"). */
  managedServiceNames: string[];
}

export async function buildSettings(flags: CliFlags): Promise<BuildResult> {
  // 1. Snapshot env vars (Bun already loaded .env files)
  const envVars: Record<string, string | undefined> = { ...process.env };

  // 2. Merge CLI flags + env vars + defaults
  const config = resolveConfig(flags, envVars);

  // Log encryption key status on startup (masked — never the raw secret)
  console.log(describeEncryptionKeyForLog(config.settings.encryptionKey));

  // 3. Start services if needed
  const { ensureServices } = await import("../services/ensure-services");
  const { outputs: serviceOutputs, services } = await ensureServices({
    home: config.settings.dataDir,
    externalDatabaseUrl: config.externalDatabaseUrl,
    externalNatsUrl: config.externalNatsUrl,
  });

  // 4. Run migrations (pass a database instance directly since settings
  //    aren't frozen yet — getDb()/getSettings() aren't available)
  if (!config.skipMigrations) {
    // Better Auth migrations must run first (creates organization table etc.)
    const { migrateBetterAuth } = await import("../auth/migrate");
    await migrateBetterAuth(serviceOutputs.databaseUrl);

    // Then Kysely migrations (reference Better Auth tables)
    const { createDatabase } = await import("../database/index");
    const { migrateToLatest } = await import("../database/migrate");
    const database = createDatabase(serviceOutputs.databaseUrl);
    await migrateToLatest({ keepOpen: true, database, skipBetterAuth: true });
  }

  // NOTE: the ClickHouse `studio_monitoring_logs` view the dashboard reads is
  // NOT created here — it's a one-time manual provisioning step (the app only
  // needs read access). See apps/api/src/monitoring/clickhouse-setup.md.

  // 5. Assemble and freeze. Thread the resolved S3 config (managed MinIO or an
  // external store) into the frozen Settings so the in-process serve path
  // resolves the real S3Service. ensureServices also mirrors these into
  // process.env so a spawned `dev:servers` child re-derives the same config.
  const settings: Settings = {
    ...config.settings,
    databaseUrl: serviceOutputs.databaseUrl,
    natsUrls: serviceOutputs.natsUrls,
    ...(serviceOutputs.s3
      ? {
          s3Endpoint: serviceOutputs.s3.endpoint,
          s3Bucket: serviceOutputs.s3.bucket,
          s3AccessKeyId: serviceOutputs.s3.accessKeyId,
          s3SecretAccessKey: serviceOutputs.s3.secretAccessKey,
          s3ForcePathStyle: serviceOutputs.s3.forcePathStyle,
        }
      : {}),
    // Dev NATS operator/JWT config (managed operator-mode NATS). Threaded so
    // the in-process serve path mints real session creds and the cluster
    // authenticates with its creds file. Null/absent in production (external
    // NATS), where these come from the deployment env via resolveConfig.
    ...(serviceOutputs.natsTunnel
      ? {
          natsPublicUrl: serviceOutputs.natsTunnel.publicUrl,
          natsAccountJwt: serviceOutputs.natsTunnel.accountJwt,
          natsAccountSigningKey: serviceOutputs.natsTunnel.accountSigningKey,
          natsOperatorJwt: serviceOutputs.natsTunnel.operatorJwt,
          natsTunnelPublicEnabled: true,
          natsCredsPath: serviceOutputs.natsTunnel.credsPath,
        }
      : {}),
  };

  setGlobalSettings(settings);
  return {
    settings,
    services: services.map((s) => ({
      name: s.name === "PostgreSQL" ? "Postgres" : s.name,
      port: s.port,
    })),
    managedServiceNames: services
      .filter((s) => s.owner === "managed")
      .map((s) => s.name),
  };
}
