/**
 * Migration 097: Drop persisted state for the retired `local-docker` sandbox
 * provider.
 *
 * The Docker sandbox provider has been removed. Any persisted `local-docker`
 * rows/cells are orphaned pointers to containers that no longer exist (and
 * don't survive a mesh restart), and the strict readers
 * (`parseBranchMap` / `parseSandboxRecord`) no longer accept the kind — Zod
 * skips/throws on it. Two idempotent steps:
 *
 *  (1) Delete `sandbox_runner_state` rows with
 *      `sandbox_provider_kind = 'local-docker'`.
 *  (2) Remove the `local-docker` cell from every
 *      `connections.metadata.sandboxMap[user][branch]`. Branch and user
 *      buckets that become empty are dropped too, matching `parseBranchMap`'s
 *      treatment of a missing cell.
 *
 * Mirrors the 079/084 "drop retired-runner state" precedent. Irreversible:
 * the provider is gone, so there is nothing meaningful to restore.
 */

import { sql, type Kysely } from "kysely";

type SandboxRecord = Record<string, unknown>;
type BranchMap = Record<string, SandboxRecord>;
type UserMap = Record<string, BranchMap>;
type SandboxMap = Record<string, UserMap>;

const RETIRED_KIND = "local-docker";

export async function up(db: Kysely<unknown>): Promise<void> {
  // (1) sandbox_runner_state rows.
  await sql`delete from sandbox_runner_state where sandbox_provider_kind = ${RETIRED_KIND}`.execute(
    db,
  );

  // (2) sandboxMap cells. Row-by-row JSON rewrite (mirrors migration 079) —
  // the LIKE filter keeps it a no-op for connections that never carried the
  // retired kind, which also makes re-runs after the first pass a no-op.
  const result = await sql<{ id: string; metadata: string | null }>`
    SELECT id, metadata FROM "connections"
    WHERE connection_type = 'VIRTUAL'
      AND metadata IS NOT NULL
      AND metadata LIKE ${"%" + RETIRED_KIND + "%"}
  `.execute(db);

  for (const row of result.rows) {
    if (!row.metadata) continue;

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      continue;
    }

    const sandboxMap = meta.sandboxMap;
    if (!sandboxMap || typeof sandboxMap !== "object") continue;

    let changed = false;
    const nextSandboxMap: SandboxMap = {};

    for (const [userId, userMap] of Object.entries(sandboxMap as SandboxMap)) {
      if (!userMap || typeof userMap !== "object") {
        changed = true;
        continue;
      }

      const nextUserMap: UserMap = {};
      for (const [branch, branchMap] of Object.entries(userMap)) {
        if (!branchMap || typeof branchMap !== "object") {
          changed = true;
          continue;
        }

        if (RETIRED_KIND in branchMap) {
          changed = true;
          const nextBranchMap: BranchMap = { ...branchMap };
          delete nextBranchMap[RETIRED_KIND];
          if (Object.keys(nextBranchMap).length > 0) {
            nextUserMap[branch] = nextBranchMap;
          }
        } else {
          nextUserMap[branch] = branchMap;
        }
      }

      if (Object.keys(nextUserMap).length > 0) {
        nextSandboxMap[userId] = nextUserMap;
      } else {
        changed = true;
      }
    }

    if (!changed) continue;

    meta.sandboxMap = nextSandboxMap;
    const updated = JSON.stringify(meta);

    await sql`
      UPDATE "connections"
      SET metadata = ${updated}
      WHERE id = ${row.id}
    `.execute(db);
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // Irreversible — the local-docker provider is gone, so restoring deleted
  // rows/cells would point at containers that no longer exist.
}
