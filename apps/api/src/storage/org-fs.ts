import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { Database, OrgFsEntryTable } from "./types";

/** A manifest row in public form — bigint columns coerced to numbers/strings. */
export interface OrgFsEntry {
  organizationId: string;
  volume: string;
  path: string;
  parent: string;
  kind: "file" | "dir";
  contentHash: string | null;
  size: number;
  /** Change-feed cursor for this row. Strings preserve bigint precision. */
  seq: string;
  deletedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** Chat/run that last wrote this file; null when not tied to a dispatch. */
  threadId: string | null;
  /** When true, the `/read` proxy serves this entry by link (own flag). */
  readPublic: boolean;
  /** This node's own share mode, derived from read_public + password presence.
   *  The raw password hash is NEVER exposed — only this derived label. */
  shareMode: ShareMode;
}

export type ShareMode = "private" | "public" | "password";

type OrgFsEntryRow = {
  organization_id: string;
  volume: string;
  path: string;
  parent: string;
  kind: "file" | "dir";
  content_hash: string | null;
  size: string | number;
  seq: string | number;
  deleted_at: Date | string | null;
  created_by: string;
  created_at: Date | string;
  updated_by: string;
  updated_at: Date | string;
  thread_id: string | null;
  read_public: boolean;
  share_password_hash: string | null;
};

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function rowToEntry(row: OrgFsEntryRow): OrgFsEntry {
  return {
    organizationId: row.organization_id,
    volume: row.volume,
    path: row.path,
    parent: row.parent,
    kind: row.kind,
    contentHash: row.content_hash,
    size: Number(row.size),
    seq: String(row.seq),
    deletedAt: toIso(row.deleted_at),
    createdBy: row.created_by,
    createdAt: toIso(row.created_at) ?? "",
    updatedBy: row.updated_by,
    updatedAt: toIso(row.updated_at) ?? "",
    threadId: row.thread_id,
    readPublic: row.read_public,
    shareMode: !row.read_public
      ? "private"
      : row.share_password_hash
        ? "password"
        : "public",
  };
}

const COLUMNS = [
  "organization_id",
  "volume",
  "path",
  "parent",
  "kind",
  "content_hash",
  "size",
  "seq",
  "deleted_at",
  "created_by",
  "created_at",
  "updated_by",
  "updated_at",
  "thread_id",
  "read_public",
  // Selected to DERIVE shareMode in rowToEntry; the raw hash is dropped there
  // and never reaches the DTO/API.
  "share_password_hash",
] as const satisfies readonly (keyof OrgFsEntryTable)[];

/** Bump `seq` to the next value of the global sequence on every write. */
const NEXT_SEQ = sql<string>`nextval('org_fs_entry_seq')`;

/**
 * Kysely operations over the org filesystem manifest (`org_fs_entry`). Pure
 * metadata + change-feed bookkeeping — bytes are handled by the `OrgFs`
 * service over object storage. Org-agnostic: the org id is passed per call.
 */
export class OrgFsEntryStorage {
  constructor(private db: Kysely<Database>) {}

  /** Upsert a file entry, bumping `seq`. Clears any prior tombstone. */
  async putFile(params: {
    organizationId: string;
    volume: string;
    path: string;
    parent: string;
    contentHash: string;
    size: number;
    actor: string;
    /** Chat/run writing this file. Null for writes not tied to a dispatch. */
    threadId?: string | null;
  }): Promise<OrgFsEntry> {
    const now = new Date();
    const threadId = params.threadId ?? null;
    const row = await this.db
      .insertInto("org_fs_entry")
      .values({
        organization_id: params.organizationId,
        volume: params.volume,
        path: params.path,
        parent: params.parent,
        kind: "file",
        content_hash: params.contentHash,
        size: params.size,
        deleted_at: null,
        created_by: params.actor,
        created_at: now,
        updated_by: params.actor,
        updated_at: now,
        thread_id: threadId,
      })
      .onConflict((oc) =>
        oc.columns(["organization_id", "volume", "path"]).doUpdateSet({
          kind: "file",
          content_hash: params.contentHash,
          size: params.size,
          deleted_at: null,
          updated_by: params.actor,
          updated_at: now,
          seq: NEXT_SEQ,
          // Reviving a tombstone (delete + recreate at the same path) starts
          // private — a regenerated file must not silently re-expose itself.
          // An in-place overwrite of a LIVE row keeps its current visibility
          // (editing a published deck stays published).
          read_public: sql<boolean>`case when org_fs_entry.deleted_at is not null then false else org_fs_entry.read_public end`,
          // Keep the existing thread stamp when this write isn't thread-tied
          // (e.g. the mount's vfs write-back echoes the deck-buffer's bytes
          // with no thread) so the fast-path provenance isn't nulled out.
          thread_id: sql<
            string | null
          >`coalesce(cast(${threadId} as text), org_fs_entry.thread_id)`,
        }),
      )
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    return rowToEntry(row as OrgFsEntryRow);
  }

  /**
   * Ensure a directory entry exists. Idempotent: an existing live dir is left
   * untouched (no `seq` bump) so the change feed stays meaningful.
   */
  async putDir(params: {
    organizationId: string;
    volume: string;
    path: string;
    parent: string;
    actor: string;
  }): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto("org_fs_entry")
      .values({
        organization_id: params.organizationId,
        volume: params.volume,
        path: params.path,
        parent: params.parent,
        kind: "dir",
        content_hash: null,
        size: 0,
        deleted_at: null,
        created_by: params.actor,
        created_at: now,
        updated_by: params.actor,
        updated_at: now,
      })
      .onConflict((oc) =>
        // Only revive a tombstoned dir; otherwise no-op (don't bump seq).
        oc
          .columns(["organization_id", "volume", "path"])
          .where("org_fs_entry.deleted_at", "is not", null)
          .doUpdateSet({
            kind: "dir",
            // Reset file-only fields: the revived row may have been a tombstoned
            // file, whose stale sha256/size must not linger on a directory.
            content_hash: null,
            size: 0,
            deleted_at: null,
            updated_by: params.actor,
            updated_at: now,
            seq: NEXT_SEQ,
            // Reviving a tombstone starts private; a no-op put on a LIVE dir
            // must keep its current flag (a published folder stays published
            // when a child is written under it). The `.where` above is an ON
            // CONFLICT index-predicate, NOT an update guard, so this set fires
            // for live dirs too — the CASE is what actually gates the reset.
            read_public: sql<boolean>`case when org_fs_entry.deleted_at is not null then false else org_fs_entry.read_public end`,
          }),
      )
      .execute();
  }

  async get(
    organizationId: string,
    volume: string,
    path: string,
  ): Promise<OrgFsEntry | null> {
    const row = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("path", "=", path)
      .where("deleted_at", "is", null)
      .select(COLUMNS)
      .executeTakeFirst();
    return row ? rowToEntry(row as OrgFsEntryRow) : null;
  }

  /** Immediate live children of a directory. */
  async listDir(
    organizationId: string,
    volume: string,
    parent: string,
  ): Promise<OrgFsEntry[]> {
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("parent", "=", parent)
      .where("deleted_at", "is", null)
      .select(COLUMNS)
      .orderBy("path", "asc")
      .execute();
    return rows.map((r) => rowToEntry(r as OrgFsEntryRow));
  }

  /** Every live dir in a volume (the public-set syncer's prune base). */
  async listVolumeDirs(
    organizationId: string,
    volume: string,
  ): Promise<OrgFsEntry[]> {
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("kind", "=", "dir")
      .where("deleted_at", "is", null)
      .select(COLUMNS)
      .execute();
    return rows.map((r) => rowToEntry(r as OrgFsEntryRow));
  }

  /** Every live file in a volume (the public-set syncer's diff base). */
  async listVolumeFiles(
    organizationId: string,
    volume: string,
  ): Promise<OrgFsEntry[]> {
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("kind", "=", "file")
      .where("deleted_at", "is", null)
      .select(COLUMNS)
      .execute();
    return rows.map((r) => rowToEntry(r as OrgFsEntryRow));
  }

  /**
   * All live file entries under a directory path (recursive). Used for
   * recursive delete/move. `dirPath` must be normalized (no trailing slash).
   */
  async listSubtreeFiles(
    organizationId: string,
    volume: string,
    dirPath: string,
  ): Promise<OrgFsEntry[]> {
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("kind", "=", "file")
      .where("deleted_at", "is", null)
      .where("path", "like", `${escapeLike(dirPath)}/%`)
      .select(COLUMNS)
      .execute();
    return rows.map((r) => rowToEntry(r as OrgFsEntryRow));
  }

  /**
   * All live directory entries under a directory path (recursive). Used by
   * move() to recreate empty subdirectories that the file-only copy misses.
   * `dirPath` must be normalized (no trailing slash).
   */
  async listSubtreeDirs(
    organizationId: string,
    volume: string,
    dirPath: string,
  ): Promise<OrgFsEntry[]> {
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("kind", "=", "dir")
      .where("deleted_at", "is", null)
      .where("path", "like", `${escapeLike(dirPath)}/%`)
      .select(COLUMNS)
      .execute();
    return rows.map((r) => rowToEntry(r as OrgFsEntryRow));
  }

  /** Tombstone a single entry, bumping `seq`. No-op if already gone. */
  async tombstone(
    organizationId: string,
    volume: string,
    path: string,
    actor: string,
  ): Promise<void> {
    await this.db
      .updateTable("org_fs_entry")
      .set({
        deleted_at: new Date(),
        updated_by: actor,
        updated_at: new Date(),
        seq: NEXT_SEQ,
      })
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("path", "=", path)
      .where("deleted_at", "is", null)
      .execute();
  }

  /**
   * Tombstone a directory and everything under it, bumping `seq` on each
   * affected row.
   */
  async tombstoneSubtree(
    organizationId: string,
    volume: string,
    dirPath: string,
    actor: string,
  ): Promise<void> {
    await this.db
      .updateTable("org_fs_entry")
      .set({
        deleted_at: new Date(),
        updated_by: actor,
        updated_at: new Date(),
        seq: NEXT_SEQ,
      })
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("deleted_at", "is", null)
      .where((eb) =>
        eb.or([
          eb("path", "=", dirPath),
          eb("path", "like", `${escapeLike(dirPath)}/%`),
        ]),
      )
      .execute();
  }

  /**
   * Set an entry's share mode (read_public + password hash + secret) in one
   * update. Works on files and dirs: a public/password dir governs its whole
   * subtree (reads resolve the most-specific public ancestor). Returns the
   * updated entry, or null if no live entry exists. Deliberately does NOT bump
   * `seq`: visibility is metadata, not content, so the change feed (mount
   * invalidation) stays quiet — only `updated_by`/`updated_at` move.
   */
  async setShareMode(params: {
    organizationId: string;
    volume: string;
    path: string;
    readPublic: boolean;
    passwordHash: string | null;
    shareSecret: string | null;
    actor: string;
  }): Promise<OrgFsEntry | null> {
    const now = new Date();
    const row = await this.db
      .updateTable("org_fs_entry")
      .set({
        read_public: params.readPublic,
        share_password_hash: params.passwordHash,
        share_secret: params.shareSecret,
        updated_by: params.actor,
        updated_at: now,
      })
      .where("organization_id", "=", params.organizationId)
      .where("volume", "=", params.volume)
      .where("path", "=", params.path)
      .where("deleted_at", "is", null)
      .returning(COLUMNS)
      .executeTakeFirst();
    return row ? rowToEntry(row as OrgFsEntryRow) : null;
  }

  /**
   * Among `candidatePaths` (a node + its ancestors), the most-specific live
   * public node and its password hash/secret — the node that governs a read's
   * share semantics. Null when none is published.
   */
  async resolveGoverningShare(params: {
    organizationId: string;
    volume: string;
    candidatePaths: string[];
  }): Promise<{
    path: string;
    passwordHash: string | null;
    secret: string | null;
  } | null> {
    if (params.candidatePaths.length === 0) return null;
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", params.organizationId)
      .where("volume", "=", params.volume)
      .where("read_public", "=", true)
      .where("deleted_at", "is", null)
      .where("path", "in", params.candidatePaths)
      .select(["path", "share_password_hash", "share_secret"])
      .execute();
    if (rows.length === 0) return null;
    // Most-specific (longest path) wins — a node's own setting overrides an
    // inherited one.
    rows.sort((a, b) => b.path.length - a.path.length);
    const gov = rows[0]!;
    return {
      path: gov.path,
      passwordHash: gov.share_password_hash,
      secret: gov.share_secret,
    };
  }

  /**
   * True if any of `paths` is a live, public directory. Powers the read
   * route's inherited public check — a file inside a published folder serves
   * publicly. Empty `paths` → false.
   */
  async hasPublicAncestorDir(
    organizationId: string,
    volume: string,
    paths: string[],
  ): Promise<boolean> {
    if (paths.length === 0) return false;
    const row = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("kind", "=", "dir")
      .where("read_public", "=", true)
      .where("deleted_at", "is", null)
      .where("path", "in", paths)
      .select("path")
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  /**
   * Of `paths`, which are live public directories — the batch form of
   * `hasPublicAncestorDir`, for computing effective-public over many entries
   * (the cross-volume recent feed) in one query per volume.
   */
  async publicDirPaths(params: {
    organizationId: string;
    volume: string;
    paths: string[];
  }): Promise<string[]> {
    if (params.paths.length === 0) return [];
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", params.organizationId)
      .where("volume", "=", params.volume)
      .where("kind", "=", "dir")
      .where("read_public", "=", true)
      .where("deleted_at", "is", null)
      .where("path", "in", params.paths)
      .select("path")
      .execute();
    return rows.map((r) => r.path);
  }

  /** Live file count + total bytes for a volume (for quota / usage display). */
  async usage(
    organizationId: string,
    volume: string,
  ): Promise<{ files: number; bytes: number }> {
    const row = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", organizationId)
      .where("volume", "=", volume)
      .where("kind", "=", "file")
      .where("deleted_at", "is", null)
      .select((eb) => [
        eb.fn.countAll<string>().as("files"),
        eb.fn.coalesce(eb.fn.sum<string>("size"), sql<string>`0`).as("bytes"),
      ])
      .executeTakeFirst();
    return {
      files: Number(row?.files ?? 0),
      bytes: Number(row?.bytes ?? 0),
    };
  }

  /** Which of `paths` exist as live files — one batch probe (skill dirs). */
  async liveFilePaths(params: {
    organizationId: string;
    volume: string;
    paths: string[];
  }): Promise<string[]> {
    if (params.paths.length === 0) return [];
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", params.organizationId)
      .where("volume", "=", params.volume)
      .where("kind", "=", "file")
      .where("deleted_at", "is", null)
      .where("path", "in", params.paths)
      .select(["path"])
      .execute();
    return rows.map((r) => r.path);
  }

  /**
   * Most recently written live files across every volume of an org, newest
   * first (`seq` desc — the same total order the change feed uses).
   */
  async recentFiles(params: {
    organizationId: string;
    limit: number;
  }): Promise<OrgFsEntry[]> {
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", params.organizationId)
      .where("kind", "=", "file")
      .where("deleted_at", "is", null)
      .select(COLUMNS)
      .orderBy("seq", "desc")
      .limit(params.limit)
      .execute();
    return rows.map((r) => rowToEntry(r as OrgFsEntryRow));
  }

  /**
   * Live files whose path matches `query` (case-insensitive substring, so
   * folder names in the path match too), newest first across every volume.
   */
  async searchFiles(params: {
    organizationId: string;
    query: string;
    limit: number;
    /** Restrict to these volumes (unset = all of the org's volumes). */
    volumes?: string[];
  }): Promise<OrgFsEntry[]> {
    if (params.volumes && params.volumes.length === 0) return [];
    // Escape LIKE metacharacters so the query is a literal substring.
    const escaped = escapeLike(params.query);
    let qb = this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", params.organizationId)
      .where("kind", "=", "file")
      .where("deleted_at", "is", null)
      .where("path", "ilike", `%${escaped}%`);
    if (params.volumes) qb = qb.where("volume", "in", params.volumes);
    const rows = await qb
      .select(COLUMNS)
      .orderBy("seq", "desc")
      .limit(params.limit)
      .execute();
    return rows.map((r) => rowToEntry(r as OrgFsEntryRow));
  }

  /**
   * Change feed: entries (including tombstones) with `seq` greater than the
   * cursor, oldest first. Consumers invalidate/delete locally and advance the
   * cursor to the last `seq` returned.
   */
  async changesSince(params: {
    organizationId: string;
    volume: string;
    sinceSeq: string;
    limit: number;
  }): Promise<OrgFsEntry[]> {
    const rows = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", params.organizationId)
      .where("volume", "=", params.volume)
      // `seq` is bigint; cast the string cursor explicitly so the comparison
      // is numeric (and unambiguous) regardless of how the driver types the
      // parameter, rather than relying on implicit text→bigint coercion.
      .where("seq", ">", sql<string>`cast(${params.sinceSeq} as bigint)`)
      .select(COLUMNS)
      .orderBy("seq", "asc")
      .limit(params.limit)
      .execute();
    return rows.map((r) => rowToEntry(r as OrgFsEntryRow));
  }

  /** Latest change-feed cursor for a volume ("0" when empty). */
  async latestSeq(params: {
    organizationId: string;
    volume: string;
  }): Promise<string> {
    const row = await this.db
      .selectFrom("org_fs_entry")
      .where("organization_id", "=", params.organizationId)
      .where("volume", "=", params.volume)
      .select(sql<string | null>`max(seq)`.as("seq"))
      .executeTakeFirst();
    return row?.seq ?? "0";
  }
}

/** Escape LIKE wildcards in a literal path prefix. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}
