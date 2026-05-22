/**
 * Migration 089: Rename the `remote-user` SandboxProviderKind value to
 * `desktop`. The runner's behaviour is unchanged — only the discriminant
 * string moves. See packages/sandbox/server/provider/desktop/ for the
 * renamed runner.
 *
 * Three rewrite passes, all idempotent:
 *
 *  (1) sandbox_runner_state.sandbox_provider_kind = 'remote-user'
 *      → 'desktop'. Trivial column update.
 *
 *  (2) Connections (where virtualmcps live as connection_type='VIRTUAL'):
 *      rename the inner key `vmMap[user][branch]['remote-user']` →
 *      `vmMap[user][branch]['desktop']`. This is the 3-level v2 shape
 *      established by migration 087.
 *
 *  (3) Same rows: rewrite the `sandboxProviderKind` field value inside
 *      every vmMap inner entry from `'remote-user'` → `'desktop'`. This
 *      catches entries where the field doesn't match the key (shouldn't
 *      happen in steady state, but defensively normalized) and any
 *      pre-v2 legacy rows that 087 left as bare entries under a renamed
 *      kind.
 *
 * mesh-sdk's `parseBranchMap` / `parseVmMapEntry` continue to tolerate the
 * legacy `'remote-user'` value/key on read until this migration has run
 * everywhere — see packages/mesh-sdk/src/types/virtual-mcp.ts.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // (1) Runner state rows.
  await sql`
    UPDATE sandbox_runner_state
    SET sandbox_provider_kind = 'desktop'
    WHERE sandbox_provider_kind = 'remote-user'
  `.execute(db);

  // (2) Rename the inner kind key in vmMap. Guard with a WHERE that only
  // touches rows containing at least one `remote-user` inner key so the
  // rewrite is a no-op on already-renamed databases.
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
                        CASE WHEN kind_key = 'remote-user' THEN 'desktop' ELSE kind_key END,
                        inner_entry
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
        WHERE kind_key = 'remote-user'
      );
  `.execute(db);

  // (3) Rewrite the sandboxProviderKind field value inside each inner
  // entry. Same guard as (2): only touch rows that still carry the legacy
  // value somewhere.
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
                          WHEN inner_entry->>'sandboxProviderKind' = 'remote-user'
                            THEN jsonb_set(inner_entry, '{sandboxProviderKind}', '"desktop"'::jsonb)
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
        WHERE inner_entry->>'sandboxProviderKind' = 'remote-user'
      );
  `.execute(db);

  // Pin any threads that recorded the old kind to the new name so dispatch
  // resolution doesn't bounce through the tolerant readers forever.
  await sql`
    UPDATE threads
    SET sandbox_provider_kind = 'desktop'
    WHERE sandbox_provider_kind = 'remote-user'
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No-op. The old value `'remote-user'` is no longer recognized by the
  // runtime (the SandboxProviderKind union dropped it). Rolling forward
  // would mean reverting code too, so a DB rollback alone is never useful.
}
