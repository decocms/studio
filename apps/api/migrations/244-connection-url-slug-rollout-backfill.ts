import type { Kysely } from "kysely";
import { backfillUrlSlugs } from "./242-connection-url-slug";

/**
 * Slugs for rows that pods on the release before 242 inserted while 242
 * rolled out. Must ship in a later release than 242 to see them.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await backfillUrlSlugs(db);
}

export async function down(): Promise<void> {}
