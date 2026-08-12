/**
 * A user-less `StudioContext` bound to one organization.
 *
 * What a board workflow needs to reach GitHub: `ctx.organization` for the
 * connection lookup, and org-rebound storage facets. No principal, because
 * these run on a schedule or a queue rather than for a person.
 *
 * Shared by `dbos-archive-sweep.ts` and `dbos-github-read.ts` — the two
 * workflows that touch a repo on nobody's behalf.
 */

import type { Kysely } from "kysely";
import { ContextFactory, rebindOrgScope } from "@/core/context-factory";
import type { StudioContext } from "@/core/studio-context";
import type { Database } from "@/storage/types";

/** Null when the org row is gone. */
export async function buildOrgContext(
  db: Kysely<Database>,
  orgId: string,
): Promise<StudioContext | null> {
  const org = await db
    .selectFrom("organization")
    .select(["id", "slug", "name"])
    .where("id", "=", orgId)
    .executeTakeFirst();
  if (!org) return null;
  const ctx = await ContextFactory.create();
  ctx.organization = { id: org.id, slug: org.slug, name: org.name };
  rebindOrgScope(ctx, { id: org.id, slug: org.slug });
  return ctx;
}
