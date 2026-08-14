/**
 * DBOS System-Schema Migration Runner
 *
 * Creates/updates the `dbos` schema (which DBOS owns inside studio's Postgres
 * database) as a standalone step, so it happens exactly once before any app
 * pod boots.
 *
 * Why this exists as its own entry point: studio's `--skip-migrations` flag
 * only skips studio's OWN migrations (see settings/pipeline.ts). DBOS still
 * runs its system-schema migrations on `DBOS.launch()`, so N pods booting
 * against a fresh database race on inserts into `dbos.dbos_migrations` and the
 * losers crash with unique-constraint violations — the failure documented in
 * tests/multi-pod/docker-compose.yml. Running this once, ahead of the pods,
 * removes the race.
 *
 * Deliberately separate from migrate.ts rather than folded into it: the two
 * fail independently, and `bun run migrate` keeps its exact current behavior
 * for dev, e2e and the multi-pod harness.
 *
 * Usage:
 *   bun run migrate:dbos                     (from source)
 *   bun run dist/server/migrate-dbos.js      (from the published bundle/image)
 */

import { buildDbosConfig } from "../dbos/config";
import { getSettings } from "../settings";
import { withSslmode } from "./index";

export async function migrateDbos(): Promise<void> {
  const settings = getSettings();

  // Dynamic import mirrors index.ts: setConfig must precede workflow registration.
  const { DBOS } = await import("@dbos-inc/dbos-sdk");

  DBOS.setConfig(
    buildDbosConfig({
      systemDatabaseUrl: withSslmode(
        settings.databaseUrl,
        settings.databasePgSsl,
      ),
      poolSize: settings.dbosPoolSize,
      executorID: settings.podName,
      // Dequeue nothing — this process only creates the schema.
      listenQueues: [],
    }),
  );

  // launch() is what applies the system-schema migrations.
  await DBOS.launch();
  await DBOS.shutdown();
}

if (import.meta.main) {
  (async () => {
    try {
      await migrateDbos();
      console.log("DBOS system-schema migrations completed.");
      process.exit(0);
    } catch (error) {
      console.error("DBOS system-schema migration failed:", error);
      process.exit(1);
    }
  })();
}
