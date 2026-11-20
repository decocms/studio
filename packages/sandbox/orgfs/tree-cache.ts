/**
 * An `OrgFsApi` that answers `listDir` and `stat` from an in-memory copy of the
 * volume's tree. Without it every directory a recursive walk opens (`find`,
 * `grep -r`, `du`) costs a `stat` and a `list` round trip to Studio, which is
 * minutes on a volume with a few thousand directories. The tree loads in one
 * request; file bytes and every write still go to the wrapped api.
 *
 * Freshness: a write through this cache, or a change the feed reports
 * (`invalidate`), marks the affected directory stale, and its next read lists
 * it again from Studio. The whole tree reloads once it is older than
 * `maxAgeMs`, which bounds staleness if the feed misses a change. When the tree
 * cannot load (too large, or Studio has no `tree` route), calls pass through
 * until the next reload attempt.
 */

import type { OrgFsApi, OrgFsNode } from "./api";

export interface TreeSource extends OrgFsApi {
  /** Every entry in the volume, or null when it is too large to list whole. */
  listTree(): Promise<OrgFsNode[] | null>;
}

const DEFAULT_MAX_AGE_MS = 60_000;

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

type Listing = Map<string, OrgFsNode>;

export class TreeCache implements OrgFsApi {
  /** Directory path → its children by path. null while passing through. */
  private dirs: Map<string, Listing> | null = null;
  /** Directories whose listing must be fetched again before it is served. */
  private stale = new Set<string>();
  /**
   * Counter bumped by every invalidation, and the value each directory last
   * got. A listing fetched before an invalidation it raced stays stale.
   */
  private gen = 0;
  private invalidatedAt = new Map<string, number>();
  private loadedAt = Number.NEGATIVE_INFINITY;
  private loading: Promise<void> | null = null;

  readonly readResponse?: OrgFsApi["readResponse"];

  constructor(
    private readonly api: TreeSource,
    private readonly opts: {
      maxAgeMs?: number;
      now?: () => number;
      log?: (msg: string, err?: unknown) => void;
    } = {},
  ) {
    const readResponse = api.readResponse;
    if (readResponse) this.readResponse = readResponse.bind(api);
  }

  /** A directory's listing changed outside this cache (the change feed). */
  invalidate(dir: string): void {
    this.gen++;
    this.invalidatedAt.set(dir, this.gen);
    this.stale.add(dir);
  }

  async listDir(path: string): Promise<OrgFsNode[]> {
    if (!(await this.ready())) return this.api.listDir(path);
    return [...(await this.listing(path)).values()];
  }

  async stat(path: string): Promise<OrgFsNode | null> {
    if (path === "" || !(await this.ready())) return this.api.stat(path);
    return (await this.listing(parentOf(path))).get(path) ?? null;
  }

  read(path: string): Promise<Uint8Array> {
    return this.api.read(path);
  }

  async write(
    path: string,
    body: Uint8Array,
    contentType?: string,
  ): Promise<void> {
    await this.api.write(path, body, contentType);
    this.touched(path);
  }

  async mkdir(path: string): Promise<void> {
    await this.api.mkdir(path);
    this.touched(path);
  }

  async remove(path: string): Promise<void> {
    await this.api.remove(path);
    this.dropSubtree(path);
    this.touched(path);
  }

  async move(from: string, to: string): Promise<void> {
    await this.api.move(from, to);
    this.dropSubtree(from);
    this.dropSubtree(to);
    this.touched(from);
    this.touched(to);
  }

  /** Whether the tree is loaded; (re)loads it once it is older than maxAge. */
  private async ready(): Promise<boolean> {
    const now = this.opts.now ?? Date.now;
    const maxAge = this.opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (now() - this.loadedAt >= maxAge) {
      this.loading ??= this.load().finally(() => {
        this.loading = null;
      });
      await this.loading;
    }
    return this.dirs !== null;
  }

  private async load(): Promise<void> {
    const gen = this.gen;
    let nodes: OrgFsNode[] | null = null;
    try {
      nodes = await this.api.listTree();
    } catch (err) {
      this.opts.log?.("tree load failed; listing directories one by one", err);
    }
    this.loadedAt = (this.opts.now ?? Date.now)();
    if (!nodes) {
      this.dirs = null;
      this.stale.clear();
      this.invalidatedAt.clear();
      return;
    }
    const dirs = new Map<string, Listing>([["", new Map()]]);
    for (const n of nodes) if (n.kind === "dir") dirs.set(n.path, new Map());
    // An entry whose parent is absent (filtered out) is unreachable anyway.
    for (const n of nodes) dirs.get(parentOf(n.path))?.set(n.path, n);
    this.dirs = dirs;
    this.stale = new Set();
    for (const [dir, at] of this.invalidatedAt) {
      if (at > gen) this.stale.add(dir);
      else this.invalidatedAt.delete(dir);
    }
  }

  /** A directory's children, fetched again when stale or not yet known. */
  private async listing(path: string): Promise<Listing> {
    // Re-listing a stale ancestor drops this directory if it is gone.
    if (path !== "" && this.staleAbove(path))
      await this.listing(parentOf(path));
    const cached = this.dirs?.get(path);
    if (cached && !this.stale.has(path)) return cached;
    const gen = this.gen;
    const next: Listing = new Map(
      (await this.api.listDir(path)).map((n) => [n.path, n]),
    );
    if (this.dirs) this.install(this.dirs, path, next, gen);
    return next;
  }

  private install(
    dirs: Map<string, Listing>,
    path: string,
    next: Listing,
    gen: number,
  ): void {
    const prev = dirs.get(path);
    // A child that stopped or started being a directory loses whatever was
    // cached under it; its contents are fetched when first read.
    for (const [p, n] of next) {
      if (n.kind === "dir" && prev?.get(p)?.kind !== "dir") this.dropSubtree(p);
    }
    for (const [p, n] of prev ?? []) {
      if (n.kind === "dir" && next.get(p)?.kind !== "dir") this.dropSubtree(p);
    }
    dirs.set(path, next);
    if ((this.invalidatedAt.get(path) ?? 0) <= gen) this.stale.delete(path);
  }

  private staleAbove(path: string): boolean {
    for (let dir = path; dir !== ""; ) {
      dir = parentOf(dir);
      if (this.stale.has(dir)) return true;
    }
    return false;
  }

  private dropSubtree(path: string): void {
    if (!this.dirs) return;
    const prefix = `${path}/`;
    for (const dir of this.dirs.keys()) {
      if (dir === path || dir.startsWith(prefix)) this.dirs.delete(dir);
    }
  }

  /**
   * After a write at `path`: its parent is stale, and so is every ancestor
   * whose cached listing lacks the next directory down (a write can create
   * missing ancestors).
   */
  private touched(path: string): void {
    let child = path;
    let dir = parentOf(path);
    this.invalidate(dir);
    while (dir !== "") {
      child = dir;
      dir = parentOf(dir);
      if (this.dirs?.get(dir)?.has(child)) break;
      this.invalidate(dir);
    }
  }
}
