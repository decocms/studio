/**
 * DBOS System-Schema Migration Runner
 *
 * Creates/updates the `dbos` schema (which DBOS owns inside studio's Postgres
 * database) as a standalone step, so it happens exactly once before any app
 * pod boots.
 *
 * DBOS also applies its system migrations on DBOS.launch(). Running this step
 * ahead of application startup makes migration failures explicit; the shared
 * advisory lock serializes it against any concurrently starting application.
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
import { withDbosMigrationLock } from "./dbos-migration-lock";
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

  // launch() is what applies the system-schema migrations. Under the lock even
  // here: this entry point is the designated writer, but nothing stops an app
  // pod from booting alongside it, and the SDK's version bump is not safe
  // against a second writer. See dbos-migration-lock.ts.
  await withDbosMigrationLock(
    {
      databaseUrl: withSslmode(settings.databaseUrl, settings.databasePgSsl),
    },
    async () => {
      await DBOS.launch();
      await DBOS.shutdown();
    },
  );
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
