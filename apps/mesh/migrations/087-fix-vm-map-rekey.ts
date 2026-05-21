/**
 * Migration 082: Re-do the vmMap rewrites that migrations 080 and 081
 * silently skipped.
 *
 * Both prior migrations targeted a `virtualmcps` table that was dropped in
 * migration 024 — virtual MCPs live in `connections` (with
 * `connection_type = 'VIRTUAL'`) since then. The misnamed UPDATEs raised
 * `undefined_table`, which both migrations caught with `EXCEPTION WHEN
 * undefined_table THEN NULL`, so they no-op'd and were recorded as applied
 * without rewriting any data. `connections.metadata` is also `text`, not
 * `jsonb`, so the cast must be explicit.
 *
 * This migration performs the two rewrites that should have happened:
 *
 *  (1) v1 → v2 rekey: legacy entries stored as
 *        vmMap[user][branch] = { vmId, previewUrl, ... }
 *      get wrapped under their sandboxProviderKind:
 *        vmMap[user][branch][kind] = { vmId, previewUrl, ... }
 *      Falls back to `runnerKind` (the pre-080 name), then `"docker"`.
 *
 *  (2) Field rename: any inner entry that still has `runnerKind` and not
 *      `sandboxProviderKind` is rewritten to use the new key.
 *
 * Both passes are idempotent — re-running on an already-clean row is a
 * no-op. The mesh-sdk `parseBranchMap` / `parseVmMapEntry` tolerant
 * readers, plus the matching Zod preprocess adapters in `virtual-mcp.ts`,
 * continue to accept either shape on read until this migration has run
 * everywhere.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // Pass 1: v1 (2-level, bare VmMapEntry at branch) → v2 (3-level, keyed
  // by sandboxProviderKind). Only rewrites rows that still contain at least
  // one branch whose value carries `vmId` directly (= legacy shape marker).
  await sql`
    UPDATE connections c
    SET metadata = (
      jsonb_set(
        c.metadata::jsonb,
        '{vmMap}',
        (
          SELECT jsonb_object_agg(
            user_key,
            COALESCE(
              (
                SELECT jsonb_object_agg(
                  branch_key,
                  CASE
                    WHEN entry ? 'vmId' THEN
                      jsonb_build_object(
                        COALESCE(
                          entry->>'sandboxProviderKind',
                          entry->>'runnerKind',
                          'docker'
                        ),
                        entry
                      )
                    ELSE entry
                  END
                )
                FROM jsonb_each(user_map) AS branches(branch_key, entry)
              ),
              '{}'::jsonb
            )
          )
          FROM jsonb_each(c.metadata::jsonb -> 'vmMap') AS users(user_key, user_map)
        )
      )
    )::text
    WHERE c.connection_type = 'VIRTUAL'
      AND c.metadata IS NOT NULL
      AND c.metadata::jsonb ? 'vmMap'
      AND EXISTS (
        SELECT 1
        FROM jsonb_each(c.metadata::jsonb -> 'vmMap') AS users(user_key, user_map)
        JOIN jsonb_each(user_map) AS branches(branch_key, entry) ON true
        WHERE entry ? 'vmId'
      );
  `.execute(db);

  // Pass 2: rename `runnerKind` → `sandboxProviderKind` on every inner
  // entry of the (now v2) 3-level structure. Only rewrites rows that
  // still have at least one such inner entry.
  await sql`
    UPDATE connections c
    SET metadata = (
      jsonb_set(
        c.metadata::jsonb,
        '{vmMap}',
        (
          SELECT jsonb_object_agg(
            user_key,
            COALESCE(
              (
                SELECT jsonb_object_agg(
                  branch_key,
                  COALESCE(
                    (
                      SELECT jsonb_object_agg(
                        kind_key,
                        CASE
                          WHEN inner_entry ? 'runnerKind'
                               AND NOT inner_entry ? 'sandboxProviderKind'
                            THEN jsonb_set(
                                   inner_entry,
                                   '{sandboxProviderKind}',
                                   inner_entry->'runnerKind'
                                 ) - 'runnerKind'
                          WHEN inner_entry ? 'runnerKind'
                            THEN inner_entry - 'runnerKind'
                          ELSE inner_entry
                        END
                      )
                      FROM jsonb_each(branch_entry) AS kinds(kind_key, inner_entry)
                    ),
                    '{}'::jsonb
                  )
                )
                FROM jsonb_each(user_map) AS branches(branch_key, branch_entry)
              ),
              '{}'::jsonb
            )
          )
          FROM jsonb_each(c.metadata::jsonb -> 'vmMap') AS users(user_key, user_map)
        )
      )
    )::text
    WHERE c.connection_type = 'VIRTUAL'
      AND c.metadata IS NOT NULL
      AND c.metadata::jsonb ? 'vmMap'
      AND EXISTS (
        SELECT 1
        FROM jsonb_each(c.metadata::jsonb -> 'vmMap') AS users(user_key, user_map)
        JOIN jsonb_each(user_map) AS branches(branch_key, branch_entry) ON true
        JOIN jsonb_each(branch_entry) AS kinds(kind_key, inner_entry) ON true
        WHERE inner_entry ? 'runnerKind'
      );
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No-op. Reversing this would mean reintroducing two distinct legacy
  // shapes (v1 layout AND `runnerKind` field) that the rest of the
  // codebase has already moved past. Restoration is not useful — readers
  // still tolerate both shapes via mesh-sdk's preprocess adapters and the
  // `parseBranchMap` / `parseVmMapEntry` helpers, so a rollback is never
  // needed to recover behavior.
}
