import { createHash } from "node:crypto";
import type { BoundObjectStorage } from "../object-storage/bound-object-storage";
import { detectContentType } from "../object-storage/key-utils";
import type {
  OrgFsEntry,
  OrgFsEntryStorage,
  ShareMode,
} from "../storage/org-fs";
import {
  ancestorsOf,
  assertValidVolume,
  fsObjectKey,
  fsVolumePrefix,
  normalizeFsPath,
  parentOf,
} from "./org-fs-path";
import { generateShareSecret, hashSharePassword } from "./share-password";

/** What the `/read` proxy should do for a given path. */
export type ReadAccess =
  | { access: "private" }
  | { access: "public" }
  | {
      access: "password";
      /** Node the password sits on — the unlock cookie's scope. */
      govPath: string;
      /** Current secret version (rotated on password change). */
      secret: string;
      /** scrypt hash (server-only — never sent to clients). */
      passwordHash: string;
    };

const DEFAULT_CHANGES_LIMIT = 500;
const LIST_PAGE_SIZE = 1000;

/** Per-file ceiling — matches the sandbox transfer cap (`MAX_TRANSFER_BYTES`). */
const DEFAULT_MAX_FILE_BYTES = 500 * 1024 * 1024;
/** Per-volume soft quota; writes that would exceed it are rejected. */
const DEFAULT_VOLUME_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

export interface OrgFsLimits {
  maxFileBytes?: number;
  volumeQuotaBytes?: number;
}

/** Thrown when a write would exceed the per-file or per-volume limit (→ 413). */
export class OrgFsQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgFsQuotaError";
  }
}

/** Thrown for invalid paths / volumes / illegal ops (→ 400). */
export class OrgFsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgFsValidationError";
  }
}

/** Thrown when a required path is absent (→ 404). */
export class OrgFsNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgFsNotFoundError";
  }
}

/**
 * Object-storage "the bytes aren't there": S3 `NoSuchKey`/404 and the dev
 * filesystem's `ENOENT`.
 */
export function isMissingObjectError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as {
    name?: string;
    code?: string;
    Code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return (
    e.name === "NoSuchKey" ||
    e.name === "NotFound" ||
    e.Code === "NoSuchKey" ||
    e.code === "ENOENT" ||
    e.$metadata?.httpStatusCode === 404
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The org filesystem: path/tree semantics over the org-prefixed object-storage
 * keyspace (`_fs/{volume}/...`), with a manifest (`org_fs_entry`) for cheap
 * directory listing, a change feed, and conflict detection. Bytes flow through
 * the existing `BoundObjectStorage`; the mount/sync engine (later phase)
 * consumes `listDir`/`changes` + presigned URLs. Org-scoped: one instance per
 * organization (the bound storage already bakes in the org id).
 *
 * See `.context/org-filesystem-proposal.md`.
 */
export class OrgFs {
  private readonly maxFileBytes: number;
  private readonly volumeQuotaBytes: number;

  constructor(
    private readonly storage: BoundObjectStorage,
    private readonly manifest: OrgFsEntryStorage,
    private readonly organizationId: string,
    limits: OrgFsLimits = {},
  ) {
    this.maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.volumeQuotaBytes =
      limits.volumeQuotaBytes ?? DEFAULT_VOLUME_QUOTA_BYTES;
  }

  /** Live file count + total bytes for a volume. */
  async usage(volume: string): Promise<{ files: number; bytes: number }> {
    assertValidVolume(volume);
    return this.manifest.usage(this.organizationId, volume);
  }

  async stat(volume: string, path: string): Promise<OrgFsEntry | null> {
    assertValidVolume(volume);
    return this.manifest.get(
      this.organizationId,
      volume,
      normalizeFsPath(path),
    );
  }

  /** Live immediate children of a directory (root when path is empty). */
  async listDir(volume: string, path: string): Promise<OrgFsEntry[]> {
    assertValidVolume(volume);
    return this.manifest.listDir(
      this.organizationId,
      volume,
      normalizeFsPath(path),
    );
  }

  /**
   * Raw bytes of a file. Throws `OrgFsNotFoundError` if the path is not a live
   * file — including when the manifest row exists but the object doesn't
   * (a diverged volume, e.g. a manifest restored against a different bucket).
   * That divergence used to escape as a raw storage error, which the routes
   * 500'd; a 404 is both the truth and something callers already handle.
   */
  async read(volume: string, path: string): Promise<Uint8Array> {
    const entry = await this.requireFile(volume, path);
    const key = fsObjectKey(volume, entry.path);
    try {
      return await this.storage.getBytes(key);
    } catch (err) {
      if (isMissingObjectError(err)) {
        throw new OrgFsNotFoundError(`No stored bytes for: ${entry.path}`);
      }
      throw err;
    }
  }

  /**
   * Set an entry's share mode. `private`/`public` clear any password;
   * `password` requires `opts.password`, hashes it, and rotates the node's
   * secret (invalidating previously-issued unlock cookies). Works on a file or
   * a dir (a dir governs its whole subtree). Throws if the path is not live.
   */
  async setShareMode(
    volume: string,
    path: string,
    mode: ShareMode,
    opts: { actor: string; password?: string },
  ): Promise<OrgFsEntry> {
    assertValidVolume(volume);
    const normalized = normalizeFsPath(path);
    const entry = await this.manifest.get(
      this.organizationId,
      volume,
      normalized,
    );
    if (!entry) throw new OrgFsNotFoundError(`No such path: ${normalized}`);

    let passwordHash: string | null = null;
    let shareSecret: string | null = null;
    if (mode === "password") {
      if (!opts.password) {
        throw new OrgFsValidationError(
          "A password is required to set password mode",
        );
      }
      passwordHash = await hashSharePassword(opts.password);
      shareSecret = generateShareSecret();
    }
    const updated = await this.manifest.setShareMode({
      organizationId: this.organizationId,
      volume,
      path: entry.path,
      readPublic: mode !== "private",
      passwordHash,
      shareSecret,
      actor: opts.actor,
    });
    // The stat above proved the row exists and is live; the update can only
    // miss on a concurrent delete, which we treat as not-found.
    if (!updated) {
      throw new OrgFsNotFoundError(`No such path: ${entry.path}`);
    }
    return updated;
  }

  /** Public/private convenience over setShareMode (clears any password). */
  async setReadPublic(
    volume: string,
    path: string,
    readPublic: boolean,
    opts: { actor: string },
  ): Promise<OrgFsEntry> {
    return this.setShareMode(volume, path, readPublic ? "public" : "private", {
      actor: opts.actor,
    });
  }

  /**
   * What the `/read` proxy should do for `path`: private (member-gated),
   * public (serve to anyone), or password (serve the form/check the cookie).
   * Resolves the most-specific published node (self or ancestor) — its
   * password decides public-vs-gated.
   */
  async resolveReadAccess(volume: string, path: string): Promise<ReadAccess> {
    assertValidVolume(volume);
    const normalized = normalizeFsPath(path);
    const entry = await this.manifest.get(
      this.organizationId,
      volume,
      normalized,
    );
    if (!entry || entry.kind !== "file") return { access: "private" };
    const gov = await this.manifest.resolveGoverningShare({
      organizationId: this.organizationId,
      volume,
      candidatePaths: [normalized, ...ancestorsOf(normalized)],
    });
    if (!gov) return { access: "private" };
    if (!gov.passwordHash) return { access: "public" };
    return {
      access: "password",
      govPath: gov.path,
      secret: gov.secret ?? "",
      passwordHash: gov.passwordHash,
    };
  }

  /**
   * Whether `path` is a live file the `/read` proxy may serve to anyone:
   * either its own `read_public` flag is set, or it inherits from a public
   * ancestor directory (publishing a folder publishes everything under it,
   * now and later). Dirs and missing paths are not readable.
   */
  async isPubliclyReadable(volume: string, path: string): Promise<boolean> {
    assertValidVolume(volume);
    const normalized = normalizeFsPath(path);
    const entry = await this.manifest.get(
      this.organizationId,
      volume,
      normalized,
    );
    if (!entry || entry.kind !== "file") return false;
    if (entry.readPublic) return true;
    return this.manifest.hasPublicAncestorDir(
      this.organizationId,
      volume,
      ancestorsOf(normalized),
    );
  }

  /**
   * Whether `path` inherits public visibility from a published ancestor dir
   * (its own `read_public` flag is NOT considered). Used to derive an entry's
   * `effectivePublic = entry.readPublic || inheritsPublic(path)`.
   */
  async inheritsPublic(volume: string, path: string): Promise<boolean> {
    assertValidVolume(volume);
    return this.manifest.hasPublicAncestorDir(
      this.organizationId,
      volume,
      ancestorsOf(normalizeFsPath(path)),
    );
  }

  /**
   * Whether the immediate children of `containerPath` inherit public — i.e.
   * the container itself or any of its ancestors is a published dir. One query
   * that resolves the inherited bit for a whole directory listing.
   */
  async childrenInheritPublic(
    volume: string,
    containerPath: string,
  ): Promise<boolean> {
    assertValidVolume(volume);
    const norm = normalizeFsPath(containerPath);
    if (norm === "") return false;
    return this.manifest.hasPublicAncestorDir(this.organizationId, volume, [
      ...ancestorsOf(norm),
      norm,
    ]);
  }

  /**
   * `recent()` with `effectivePublic` per entry (own flag OR a published
   * ancestor dir).
   */
  async recentWithEffectivePublic(
    limit: number,
  ): Promise<Array<OrgFsEntry & { effectivePublic: boolean }>> {
    return this.withEffectivePublic(await this.recent(limit));
  }

  /**
   * Path search (case-insensitive substring) with `effectivePublic` per
   * entry — the Library's search box. Searches every volume unless
   * `volumes` narrows it (the public-sets pseudo-org passes its configured
   * set volumes), and the whole volume unless `pathPrefix` narrows it to one
   * directory subtree (the Library scopes search to the folder you're in).
   */
  async searchWithEffectivePublic(
    query: string,
    limit: number,
    volumes?: string[],
    pathPrefix?: string,
  ): Promise<Array<OrgFsEntry & { effectivePublic: boolean }>> {
    return this.withEffectivePublic(
      await this.manifest.searchFiles({
        organizationId: this.organizationId,
        query,
        limit,
        volumes,
        pathPrefix: pathPrefix ? normalizeFsPath(pathPrefix) : undefined,
      }),
    );
  }

  /**
   * Resolve `effectivePublic` (own flag OR a published ancestor dir) for a
   * cross-volume entry list. Batches the ancestor lookup to one query per
   * volume so the feeds stay cheap.
   */
  private async withEffectivePublic(
    entries: OrgFsEntry[],
  ): Promise<Array<OrgFsEntry & { effectivePublic: boolean }>> {
    const ancestorsByVolume = new Map<string, Set<string>>();
    for (const e of entries) {
      let set = ancestorsByVolume.get(e.volume);
      if (!set) {
        set = new Set();
        ancestorsByVolume.set(e.volume, set);
      }
      for (const a of ancestorsOf(e.path)) set.add(a);
    }
    const publicByVolume = new Map<string, Set<string>>();
    await Promise.all(
      [...ancestorsByVolume].map(async ([volume, paths]) => {
        const found = await this.manifest.publicDirPaths({
          organizationId: this.organizationId,
          volume,
          paths: [...paths],
        });
        publicByVolume.set(volume, new Set(found));
      }),
    );
    return entries.map((e) => {
      const publicDirs = publicByVolume.get(e.volume);
      const inherited =
        !!publicDirs && ancestorsOf(e.path).some((a) => publicDirs.has(a));
      return { ...e, effectivePublic: e.readPublic || inherited };
    });
  }

  /** Presigned GET URL for a file — the byte path the mount fetches lazily. */
  async presignRead(
    volume: string,
    path: string,
    expiresIn?: number,
  ): Promise<string> {
    const entry = await this.requireFile(volume, path);
    return this.storage.presignedGetUrl(
      fsObjectKey(volume, entry.path),
      expiresIn,
    );
  }

  /** Write bytes, creating parent dirs as needed, and update the manifest. */
  async write(
    volume: string,
    path: string,
    body: string | Uint8Array,
    opts: {
      actor: string;
      contentType?: string;
      skipVolumeQuota?: boolean;
      /** Chat/run writing this file — scopes live deck previews. Omit for
       *  writes not tied to a dispatch (mount write-backs, backfill). */
      threadId?: string | null;
    },
  ): Promise<OrgFsEntry> {
    assertValidVolume(volume);
    const normalized = normalizeFsPath(path);
    if (normalized === "") {
      throw new OrgFsValidationError("Cannot write to the volume root");
    }
    const bytes =
      typeof body === "string" ? new TextEncoder().encode(body) : body;

    if (bytes.byteLength > this.maxFileBytes) {
      throw new OrgFsQuotaError(
        `File exceeds the ${this.maxFileBytes}-byte per-file limit`,
      );
    }
    // Soft per-volume quota. Subtract the existing size of this exact path so
    // overwriting a file in place doesn't double-count.
    //
    // The quota is best-effort: two concurrent writes can each read the same
    // usage and both pass, briefly overshooting. We accept that for a *soft*
    // limit — making it strict would require threading a DB transaction
    // through both the usage read and the manifest write. Revisit if quotas
    // become billing-hard.
    //
    // `skipVolumeQuota` is set by move() for its copy leg: a same-volume rename
    // has a net delta of ≤0, but the source still counts toward usage until the
    // trailing delete, so charging it would make a rename of a file larger than
    // the remaining headroom spuriously fail (or half-apply a directory move).
    const [usage, existing] = await Promise.all([
      opts.skipVolumeQuota
        ? Promise.resolve(null)
        : this.manifest.usage(this.organizationId, volume),
      this.manifest.get(this.organizationId, volume, normalized),
    ]);
    if (existing?.kind === "dir") {
      throw new OrgFsValidationError(
        `Cannot write a file at ${normalized}: a directory exists there`,
      );
    }
    if (usage) {
      const prior = existing?.kind === "file" ? existing.size : 0;
      if (usage.bytes - prior + bytes.byteLength > this.volumeQuotaBytes) {
        throw new OrgFsQuotaError(
          `Write would exceed the volume quota of ${this.volumeQuotaBytes} bytes`,
        );
      }
    }

    await this.ensureDirs(volume, normalized, opts.actor);
    await this.storage.put(fsObjectKey(volume, normalized), bytes, {
      contentType: opts.contentType ?? detectContentType(normalized),
    });

    return this.manifest.putFile({
      organizationId: this.organizationId,
      volume,
      path: normalized,
      parent: parentOf(normalized),
      contentHash: sha256(bytes),
      size: bytes.byteLength,
      actor: opts.actor,
      threadId: opts.threadId ?? null,
    });
  }

  /**
   * Create a directory (and ancestors). Idempotent for an existing dir.
   * Rejects if a live FILE already occupies the path.
   *
   * Note: a pre-existing live file at an *ancestor* of `path` is not detected
   * (it would take a stat per ancestor on the write hot-path); such a tree is
   * reachable only by deliberately writing a file then a child under it, and
   * leaves the manifest queryable but semantically odd. Deferred.
   */
  async mkdir(
    volume: string,
    path: string,
    opts: { actor: string },
  ): Promise<void> {
    assertValidVolume(volume);
    const normalized = normalizeFsPath(path);
    if (normalized === "") return;
    const existing = await this.manifest.get(
      this.organizationId,
      volume,
      normalized,
    );
    if (existing?.kind === "file") {
      throw new OrgFsValidationError(
        `Cannot create a directory at ${normalized}: a file exists there`,
      );
    }
    await this.ensureDirs(volume, normalized, opts.actor);
    await this.manifest.putDir({
      organizationId: this.organizationId,
      volume,
      path: normalized,
      parent: parentOf(normalized),
      actor: opts.actor,
    });
  }

  /** Delete a file, or a directory and everything under it. */
  async delete(
    volume: string,
    path: string,
    opts: { actor: string },
  ): Promise<void> {
    assertValidVolume(volume);
    const normalized = normalizeFsPath(path);
    if (normalized === "") {
      throw new OrgFsValidationError("Cannot delete the volume root");
    }
    const entry = await this.manifest.get(
      this.organizationId,
      volume,
      normalized,
    );
    if (!entry) return;

    if (entry.kind === "dir") {
      const files = await this.manifest.listSubtreeFiles(
        this.organizationId,
        volume,
        normalized,
      );
      await Promise.all(
        files.map((f) => this.storage.delete(fsObjectKey(volume, f.path))),
      );
      await this.manifest.tombstoneSubtree(
        this.organizationId,
        volume,
        normalized,
        opts.actor,
      );
      return;
    }

    await this.storage.delete(fsObjectKey(volume, normalized));
    await this.manifest.tombstone(
      this.organizationId,
      volume,
      normalized,
      opts.actor,
    );
  }

  /**
   * Move/rename a file or directory. Copy-then-delete at the byte layer
   * (`BoundObjectStorage` has no native copy); directories move recursively.
   *
   * NOT atomic: a failure between the destination write and the source delete
   * leaves both present. The change feed records both, so a consumer (and a
   * future reconcile pass) converges; treat move as eventually consistent, not
   * transactional. Strict atomicity would need a cross-store transaction.
   */
  async move(
    volume: string,
    from: string,
    to: string,
    opts: { actor: string },
  ): Promise<void> {
    assertValidVolume(volume);
    const src = normalizeFsPath(from);
    const dst = normalizeFsPath(to);
    if (src === "" || dst === "") {
      throw new OrgFsValidationError("Cannot move the volume root");
    }
    // Same-path or move-into-own-descendant would copy-then-delete the source
    // onto itself → data loss. Reject both.
    if (dst === src || dst.startsWith(`${src}/`)) {
      throw new OrgFsValidationError(
        `Cannot move ${src} onto itself or into its own subtree`,
      );
    }
    const entry = await this.manifest.get(this.organizationId, volume, src);
    if (!entry) throw new OrgFsNotFoundError(`No such path: ${src}`);

    if (entry.kind === "file") {
      const bytes = await this.storage.getBytes(fsObjectKey(volume, src));
      await this.write(volume, dst, bytes, { ...opts, skipVolumeQuota: true });
      await this.delete(volume, src, opts);
      return;
    }

    const [files, dirs] = await Promise.all([
      this.manifest.listSubtreeFiles(this.organizationId, volume, src),
      this.manifest.listSubtreeDirs(this.organizationId, volume, src),
    ]);
    await this.mkdir(volume, dst, opts);
    for (const f of files) {
      const rel = f.path.slice(src.length + 1);
      const bytes = await this.storage.getBytes(fsObjectKey(volume, f.path));
      await this.write(volume, `${dst}/${rel}`, bytes, {
        ...opts,
        skipVolumeQuota: true,
      });
    }
    // Recreate every subdirectory at the destination, not just the ones that
    // are ancestors of a moved file — otherwise an empty subdir (a live `dir`
    // entry with no descendant files) would be tombstoned by the delete below
    // and never reappear at `dst`. mkdir is idempotent, so dirs already created
    // as file ancestors are no-ops.
    for (const d of dirs) {
      const rel = d.path.slice(src.length + 1);
      await this.mkdir(volume, `${dst}/${rel}`, opts);
    }
    await this.delete(volume, src, opts);
  }

  /**
   * Which of `paths` are live files — one batch query. The list route uses
   * it to mark Claude Code skill dirs (`<dir>/SKILL.md`) without N stats.
   */
  async filesExist(volume: string, paths: string[]): Promise<Set<string>> {
    assertValidVolume(volume);
    const found = await this.manifest.liveFilePaths({
      organizationId: this.organizationId,
      volume,
      paths: paths.map((p) => normalizeFsPath(p)),
    });
    return new Set(found);
  }

  /**
   * Most recently written live files across every volume, newest first.
   * Powers the Library page's "Recently added" feed.
   */
  async recent(limit: number): Promise<OrgFsEntry[]> {
    return this.manifest.recentFiles({
      organizationId: this.organizationId,
      limit,
    });
  }

  /**
   * Change feed for a volume. Returns entries (incl. tombstones) after the
   * cursor, the new cursor to persist, and `hasMore` (a full page came back,
   * so the consumer should poll again immediately rather than wait). Pass "0"
   * to start from the beginning.
   */
  async changes(
    volume: string,
    sinceSeq: string,
    limit = DEFAULT_CHANGES_LIMIT,
  ): Promise<{ entries: OrgFsEntry[]; cursor: string; hasMore: boolean }> {
    assertValidVolume(volume);
    const since = sinceSeq || "0";
    // The cursor is cast to bigint in SQL; a non-numeric value would otherwise
    // surface as a raw Postgres parse error → 500. Reject it as a 400 instead.
    if (!/^\d+$/.test(since)) {
      throw new OrgFsValidationError(`Invalid cursor: ${sinceSeq}`);
    }
    const entries = await this.manifest.changesSince({
      organizationId: this.organizationId,
      volume,
      sinceSeq: since,
      limit,
    });
    const last = entries.at(-1);
    return {
      entries,
      cursor: last ? last.seq : sinceSeq || "0",
      hasMore: entries.length >= limit,
    };
  }

  /** Latest change-feed cursor for a volume ("0" when empty). Use as the
   *  starting point for "changes from now on" consumers. */
  async latestSeq(volume: string): Promise<string> {
    assertValidVolume(volume);
    return this.manifest.latestSeq({
      organizationId: this.organizationId,
      volume,
    });
  }

  /**
   * Seed the manifest from objects already present in storage under a volume.
   * Idempotent — safe to re-run. Returns the number of file entries written.
   *
   * Relies on RECURSIVE prefix listing (real S3/R2/MinIO semantics). The
   * dev/self-host `DevObjectStorage` lists a single directory level only, so
   * backfill there sees just the volume's top-level files — use a real
   * object-storage backend to backfill a nested tree.
   */
  async backfillFromStorage(
    volume: string,
    opts: { actor: string },
  ): Promise<number> {
    assertValidVolume(volume);
    const prefix = fsVolumePrefix(volume);
    let token: string | undefined;
    let count = 0;
    do {
      const page = await this.storage.list({
        prefix,
        maxKeys: LIST_PAGE_SIZE,
        continuationToken: token,
      });
      for (const obj of page.objects) {
        const path = obj.key.slice(prefix.length);
        if (path === "") continue;
        await this.ensureDirs(volume, path, opts.actor);
        const bytes = await this.storage.getBytes(obj.key);
        await this.manifest.putFile({
          organizationId: this.organizationId,
          volume,
          path,
          parent: parentOf(path),
          contentHash: sha256(bytes),
          size: bytes.byteLength,
          actor: opts.actor,
        });
        count++;
      }
      token = page.isTruncated ? page.nextContinuationToken : undefined;
    } while (token);
    return count;
  }

  private async requireFile(volume: string, path: string): Promise<OrgFsEntry> {
    assertValidVolume(volume);
    const normalized = normalizeFsPath(path);
    const entry = await this.manifest.get(
      this.organizationId,
      volume,
      normalized,
    );
    if (!entry || entry.kind !== "file") {
      throw new OrgFsNotFoundError(`No such file: ${normalized}`);
    }
    return entry;
  }

  private async ensureDirs(
    volume: string,
    path: string,
    actor: string,
  ): Promise<void> {
    for (const dir of ancestorsOf(path)) {
      await this.manifest.putDir({
        organizationId: this.organizationId,
        volume,
        path: dir,
        parent: parentOf(dir),
        actor,
      });
    }
  }
}
