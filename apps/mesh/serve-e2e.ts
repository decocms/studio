// Live studio mesh server for the cross-PR e2e: real app, real Postgres.
// Seeds an org with id ≠ slug (proves resolve-by-id) with the board enabled,
// and one org without settings (board disabled).
process.env.ENCRYPTION_KEY ??= Buffer.from("0".repeat(32)).toString("base64");
process.env.VAULT_SERVICE_TOKEN = "svc-secret-e2e";

import { sql } from "kysely";
import {
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "./src/database/test-db-pg";
import { getSettings, setGlobalSettings } from "./src/settings";
import { OrganizationSettingsStorage } from "./src/storage/organization-settings";
import { createApp } from "./src/api/app";

if (!getSettings().encryptionKey) {
  setGlobalSettings({
    ...getSettings(),
    encryptionKey: process.env.ENCRYPTION_KEY!,
  });
}

const database = await connectTestPgDatabase();
await resetTestPgDatabase(database);
await seedCommonTestPgFixtures(database);
const now = new Date().toISOString();
await sql`
  INSERT INTO "organization" (id, name, slug, "createdAt")
  VALUES ('org_e2e', 'E2E Board Org', 'e2e-board', ${now}),
         ('org_noboard', 'No Board Org', 'e2e-noboard', ${now})
  ON CONFLICT (id) DO NOTHING
`.execute(database.db);
await new OrganizationSettingsStorage(database.db).upsert("org_e2e", {
  task_board_enabled: true,
});

const app = await createApp({ database, disableNats: true });
const server = Bun.serve({ port: 8123, fetch: (req) => app.fetch(req) });
console.log(`studio e2e server up on ${server.url}`);
