/**
 * Reads of `sandbox_runner_state`. The sandbox controller owns the table and
 * is its only writer; Studio reads it only to answer the controller's
 * credential and tenant-pool callbacks.
 */

import { sql, type Kysely } from "kysely";
import type { Database } from "./types";

/** Where a sandbox's primary clone credential is minted from. */
export type CloneCredentialSource =
  | { connectionId: string }
  | { repositoryId: string };

/**
 * Persisted states, across every runtime, whose primary repo is minted from
 * `source`. The controller's credential callback verifies against these.
 * Unindexed jsonb filter: it runs about once per sandbox per refresh interval.
 */
export async function listStatesByCloneSource(
  db: Kysely<Database>,
  source: CloneCredentialSource,
): Promise<unknown[]> {
  const matches =
    "connectionId" in source
      ? sql<boolean>`state -> 'ensureOpts' -> 'repo' ->> 'connectionId' = ${source.connectionId}`
      : sql<boolean>`state -> 'ensureOpts' -> 'repo' ->> 'repositoryId' = ${source.repositoryId}`;
  const rows = await db
    .selectFrom("sandbox_runner_state")
    .select("state")
    .where(matches)
    .execute();
  return rows.map((row) => row.state);
}

/** Persisted states, across every runtime, of sandboxes `userId` runs in `orgId`. */
export async function listStatesByTenant(
  db: Kysely<Database>,
  tenant: { orgId: string; userId: string },
): Promise<unknown[]> {
  const rows = await db
    .selectFrom("sandbox_runner_state")
    .select("state")
    .where(sql<boolean>`state -> 'tenant' ->> 'orgId' = ${tenant.orgId}`)
    .where(sql<boolean>`state -> 'tenant' ->> 'userId' = ${tenant.userId}`)
    .execute();
  return rows.map((row) => row.state);
}
