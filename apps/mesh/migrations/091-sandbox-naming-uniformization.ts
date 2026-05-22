/**
 * Migration 091: Sweep persisted state to the new sandbox-naming vocabulary.
 *
 * The runtime renames from the sandbox-naming uniformization effort are
 * complete; this migration brings stored data in line so the readers can
 * drop their tolerant legacy paths. Four idempotent steps:
 *
 *  (1) `sandbox_runner_state.sandbox_provider_kind` value rewrite:
 *        docker        → local-docker
 *        agent-sandbox → cluster
 *        desktop       → user-desktop
 *        remote-user   → user-desktop  (legacy from migration 089's
 *                                       intermediate `desktop` value)
 *
 *  (2) `connections.metadata.vmMap` top-level key → `sandboxMap`.
 *      The 3-level shape established by migration 087 is preserved; only
 *      the wrapping key changes.
 *
 *  (3) Inside each `sandboxMap[user][branch]` cell: kind keys are rewritten
 *      with the same mapping as (1), and the inner `sandboxProviderKind`
 *      field carried by each SandboxRecord is updated to match. Legacy
 *      `host` and `freestyle` cells — the discriminants those runners used —
 *      are dropped entirely; the runners are gone, so there is nothing to
 *      resume.
 *
 *  (4) Stored tool-name strings `"VM_START"` and `"VM_DELETE"` (with the
 *      surrounding quotes that delimit a JSON string token) are rewritten
 *      to `"SANDBOX_START"` / `"SANDBOX_DELETE"` anywhere in
 *      `connections.metadata`. Free-form prose mentions without quotes are
 *      intentionally left alone — agent allowlists and tool references in
 *      structured fields all encode as quoted strings, so this captures
 *      them all while keeping documentation text intact.
 *
 * All four passes are idempotent. mesh-sdk's tolerant readers
 * (`parseBranchMap` / `parseSandboxRecord`) continue to accept the legacy
 * shapes during the rolling deploy window; the follow-up task removes them
 * once this migration has run everywhere.
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // (1) sandbox_runner_state value rewrites. PK is
  // (user_id, project_ref, sandbox_provider_kind); the legacy and canonical
  // values never collide on the same row, so a plain UPDATE is fine.
  await sql`
    UPDATE sandbox_runner_state
    SET sandbox_provider_kind = CASE sandbox_provider_kind
      WHEN 'docker'        THEN 'local-docker'
      WHEN 'agent-sandbox' THEN 'cluster'
      WHEN 'desktop'       THEN 'user-desktop'
      WHEN 'remote-user'   THEN 'user-desktop'
      ELSE sandbox_provider_kind
    END
    WHERE sandbox_provider_kind IN ('docker','agent-sandbox','desktop','remote-user')
  `.execute(db);

  // (2) Rename top-level `vmMap` → `sandboxMap` on connections.metadata.
  // Guarded so already-migrated rows are skipped.
  await sql`
    UPDATE connections c
    SET metadata = (
      (c.metadata::jsonb - 'vmMap')
        || jsonb_build_object('sandboxMap', c.metadata::jsonb -> 'vmMap')
    )::text
    WHERE c.connection_type = 'VIRTUAL'
      AND c.metadata IS NOT NULL
      AND c.metadata::jsonb ? 'vmMap'
  `.execute(db);

  // (3) Rewrite the inner kind keys AND the sandboxProviderKind field
  // inside each SandboxRecord. Legacy `host` / `freestyle` cells are
  // dropped via a WHERE filter inside the inner jsonb_object_agg.
  //
  // Single combined pass: the CASE on `kind_key` produces the new key, and
  // the CASE on the entry produces the new body with sandboxProviderKind
  // updated if it carried a legacy value. If two legacy keys map to the
  // same canonical key (e.g. `desktop` + `remote-user` → `user-desktop`)
  // jsonb_object_agg keeps the last one — acceptable because both should
  // describe the same live sandbox in practice, and we re-set the field to
  // the canonical value either way.
  await sql`
    UPDATE connections c
    SET metadata = (
      jsonb_set(
        c.metadata::jsonb,
        '{sandboxMap}',
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
                        CASE kind_key
                          WHEN 'docker'        THEN 'local-docker'
                          WHEN 'agent-sandbox' THEN 'cluster'
                          WHEN 'desktop'       THEN 'user-desktop'
                          WHEN 'remote-user'   THEN 'user-desktop'
                          ELSE kind_key
                        END,
                        CASE inner_entry->>'sandboxProviderKind'
                          WHEN 'docker'
                            THEN jsonb_set(inner_entry, '{sandboxProviderKind}', '"local-docker"'::jsonb)
                          WHEN 'agent-sandbox'
                            THEN jsonb_set(inner_entry, '{sandboxProviderKind}', '"cluster"'::jsonb)
                          WHEN 'desktop'
                            THEN jsonb_set(inner_entry, '{sandboxProviderKind}', '"user-desktop"'::jsonb)
                          WHEN 'remote-user'
                            THEN jsonb_set(inner_entry, '{sandboxProviderKind}', '"user-desktop"'::jsonb)
                          ELSE inner_entry
                        END
                      )
                      FROM jsonb_each(branch_entry) AS kinds(kind_key, inner_entry)
                      WHERE kind_key NOT IN ('host','freestyle')
                    ),
                    '{}'::jsonb
                  )
                )
                FROM jsonb_each(user_map) AS branches(branch_key, branch_entry)
              ),
              '{}'::jsonb
            )
          )
          FROM jsonb_each(c.metadata::jsonb -> 'sandboxMap') AS users(user_key, user_map)
        )
      )
    )::text
    WHERE c.connection_type = 'VIRTUAL'
      AND c.metadata IS NOT NULL
      AND c.metadata::jsonb ? 'sandboxMap'
      AND EXISTS (
        SELECT 1
        FROM jsonb_each(c.metadata::jsonb -> 'sandboxMap') AS users(user_key, user_map)
        JOIN jsonb_each(user_map) AS branches(branch_key, branch_entry) ON true
        JOIN jsonb_each(branch_entry) AS kinds(kind_key, inner_entry) ON true
        WHERE kind_key IN ('docker','agent-sandbox','desktop','remote-user','host','freestyle')
           OR inner_entry->>'sandboxProviderKind' IN ('docker','agent-sandbox','desktop','remote-user')
      );
  `.execute(db);

  // (4) Tool-name string rewrites. Operating on the text form preserves
  // every other byte verbatim (including key ordering, escaping, and
  // whitespace), and the quoted form '"VM_START"' is unambiguous in JSON —
  // it can only be a complete string token. WHERE clause keeps the
  // migration a no-op for rows that don't carry the old names.
  await sql`
    UPDATE connections c
    SET metadata = REPLACE(
      REPLACE(c.metadata, '"VM_START"', '"SANDBOX_START"'),
      '"VM_DELETE"', '"SANDBOX_DELETE"'
    )
    WHERE c.connection_type = 'VIRTUAL'
      AND c.metadata IS NOT NULL
      AND (c.metadata LIKE '%"VM_START"%' OR c.metadata LIKE '%"VM_DELETE"%')
  `.execute(db);
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No down migration — the rename is hard cutover. Restore from backup if
  // needed.
}
