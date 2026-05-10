/**
 * Backfill — install the GEO Audit Agent for every existing organization.
 *
 * New orgs get this agent via `seedOrgDb` (`apps/mesh/src/auth/org.ts`)
 * which calls `installGeoAuditAgent`. This migration covers orgs that
 * existed before that hook was added. Idempotent: skips orgs that already
 * have the canonical `geo-audit_<orgId>` VIRTUAL connection.
 *
 * The system prompt is a snapshot of `apps/mesh/src/agents/geo-seo/prompt.md`
 * as of this migration. Future prompt edits affect only NEW orgs (via
 * `seedOrgDb`); to update existing orgs in bulk, write a follow-up migration.
 */

import { readFileSync } from "node:fs";
import { Kysely } from "kysely";
import { fileURLToPath } from "node:url";

const PROMPT_PATH = fileURLToPath(
  new URL("../src/agents/geo-seo/prompt.md", import.meta.url),
);

const AGENT_TITLE = "GEO Audit Agent";
const AGENT_DESCRIPTION =
  "Audit a website's visibility to AI search engines (ChatGPT, Claude, Perplexity, Google AI Overviews). Produces a composite GEO Score (0–100) and a prioritized action plan.";
const AGENT_ICON = "icon://BarChart02?color=violet";

export async function up(db: Kysely<unknown>): Promise<void> {
  const instructions = readFileSync(PROMPT_PATH, "utf-8");
  const metadata = JSON.stringify({ instructions });

  // Owner per org for created_by attribution. Same pattern as
  // migration 048-merge-projects-agents.ts.
  const orgOwners = (await db
    .selectFrom("member" as never)
    .select(["organizationId" as never, "userId" as never])
    .where("role" as never, "=", "owner" as never)
    .execute()) as Array<{ organizationId: string; userId: string }>;

  const orgOwnerMap = new Map<string, string>();
  for (const row of orgOwners) {
    if (!orgOwnerMap.has(row.organizationId)) {
      orgOwnerMap.set(row.organizationId, row.userId);
    }
  }

  const orgs = (await db
    .selectFrom("organization" as never)
    .select(["id" as never])
    .execute()) as Array<{ id: string }>;

  const now = new Date().toISOString();

  for (const org of orgs) {
    const createdBy = orgOwnerMap.get(org.id);
    if (!createdBy) continue; // skip orgs with no owner row

    const id = `geo-audit_${org.id}`;

    await db
      .insertInto("connections" as never)
      .values({
        id,
        organization_id: org.id,
        created_by: createdBy,
        updated_by: null,
        title: AGENT_TITLE,
        description: AGENT_DESCRIPTION,
        icon: AGENT_ICON,
        app_name: null,
        app_id: null,
        connection_type: "VIRTUAL",
        connection_url: `virtual://${id}`,
        connection_token: null,
        connection_headers: null,
        oauth_config: null,
        configuration_state: null,
        configuration_scopes: null,
        metadata,
        bindings: null,
        status: "active",
        pinned: false,
        subtype: "agent",
        created_at: now,
        updated_at: now,
      } as never)
      // biome-ignore lint/suspicious/noExplicitAny: kysely's onConflict signature
      .onConflict((oc: any) => oc.column("id").doNothing())
      .execute();
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Remove every GEO Audit Agent row this migration could have inserted,
  // including any added later by `seedOrgDb` for new orgs — they share the
  // canonical id prefix and have no other source.
  await db
    .deleteFrom("connections" as never)
    .where("connection_type" as never, "=", "VIRTUAL" as never)
    .where("id" as never, "like", "geo-audit_%" as never)
    .execute();
}
