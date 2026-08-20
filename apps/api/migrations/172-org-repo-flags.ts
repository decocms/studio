import type { Kysely } from "kysely";

/**
 * Per-repo overrides of the review flags, keyed by lowercased `owner/name`.
 *
 * The three review toggles (QA Agent, Code Reviewer, auto-merge) were org-wide,
 * so a workspace with several repos had to pick one review setup for all of
 * them. This bag holds only the deviations: `{"decocms/studio": {"auto_merge":
 * false}}`. A repo with no entry — every repo, before anyone configures one —
 * reads the org flag exactly as it did, which is what makes the column
 * additive.
 *
 * Shape and the read path live in ONE place,
 * `@decocms/shared/organization/schema.ts` (`OrgRepoFlagsSchema`,
 * `flagsForRepo`). Nullable on purpose: NULL means "no repo ever overridden".
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .addColumn("repo_flags", "jsonb")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("organization_settings")
    .dropColumn("repo_flags")
    .execute();
}
