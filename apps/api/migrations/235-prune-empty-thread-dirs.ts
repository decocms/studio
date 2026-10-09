import { type Kysely, sql } from "kysely";

/**
 * Tombstones the empty per-chat folders the sandbox daemon created in
 * `uploads` and `outputs` before anything was written: a top-level folder
 * named by a thread id with no live child. Only folders older than a day, so
 * a run that just repointed at its folder keeps it. `seq` is bumped like any
 * tombstone, so mounts learn of the removal through the change feed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE org_fs_entry AS d
    SET deleted_at = now(),
        updated_at = now(),
        updated_by = 'system',
        seq = nextval('org_fs_entry_seq')
    WHERE d.volume IN ('uploads', 'outputs')
      AND d.kind = 'dir'
      AND d.parent = ''
      AND d.deleted_at IS NULL
      AND d.created_at < now() - interval '1 day'
      AND d.path ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      AND NOT EXISTS (
        SELECT 1 FROM org_fs_entry AS c
        WHERE c.organization_id = d.organization_id
          AND c.volume = d.volume
          AND c.parent = d.path
          AND c.deleted_at IS NULL
      )
  `.execute(db);
}

/** Nothing to restore: the folders were empty. */
export async function down(): Promise<void> {}
