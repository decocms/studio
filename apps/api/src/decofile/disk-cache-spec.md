# Disk-backed decofile cache — implementation spec

Replaces the in-memory blob/merged LRUs and the in-heap tarball path in
`apps/api/src/decofile/` with a filesystem cache and a subprocess-based cold
read. Motivation: the current design holds whole-repo tarballs in the JS heap
(`gunzipSync`, event-loop blocking), and its entry-count LRUs have no byte
bound — both are OOM classes on a shared multi-tenant server. The cached data
is content-addressed and immutable (blobs by git SHA, merged decofiles by head
commit SHA), which makes disk caching invalidation-free and lets the OS page
cache serve hot entries at memory speed.

## Golden rules

Every implementation decision defers to these, in order:

1. **Huge payloads never touch the JS heap.** Tarballs stream from the network
   into a `tar` subprocess; only individual extracted block JSONs (small, and
   pre-validated in aggregate — see §Cold read) are ever read into strings.
   No `gunzipSync`, no `arrayBuffer()` of an archive, no accumulation of a
   whole repo in memory, ever — including in error paths.
2. **GitHub requests stay minimal.** No change may regress the request math
   that avoids 429s: the coalescer batches writes, the ETag layer makes
   unchanged re-reads free, blob fetches are bounded-concurrency (12), cold
   reads collapse to one tarball, and nothing polls. Cache failures degrade to
   MORE requests only as a last resort and must emit a metric when they do.
3. **The disk cannot fill.** The byte budget is enforced synchronously at
   write time (evict-then-write), oversized entries are refused admission, the
   tarball path is size-validated BEFORE download, a free-space floor stops
   all caching when the volume is under external pressure, and ENOSPC is a
   handled event. The app budget sits below the volume limit, which sits
   below node capacity.
4. **Fail open.** A cache problem (missing dir, ENOSPC, corrupt entry, race
   with eviction) is always a cache miss, never a request failure. Disk-full
   means slower, not broken.
5. **Never block the event loop.** All decompression happens in a child
   process; all file I/O uses async APIs. (House rule — see CONTRIBUTING.md.)

## Module layout

```
apps/api/src/decofile/
  disk-cache.ts        NEW  — store: index, budget, atomic writes, sweeper
  cache-index.ts       NEW  — PURE LRU/budget arithmetic (unit-testable)
  tar-extract.ts       NEW  — spawn `tar`, stream stdin, extract matching paths
  single-flight.ts     NEW  — per-key in-flight promise dedup (generic, tiny)
  read-decofile.ts     MOD  — swap LRUs for disk store; single-flight; guarded
                              tarball path
  commit-coalescer.ts  MOD  — `primeBlobCache` writes through to the disk store
  github-git-data.ts   MOD  — `getTarball` returns a ReadableStream (no
                              buffering); `TreeEntry` gains `size?: number`
                              (the tree API already returns it)
  tar.ts               DEL  — hand-rolled ustar parser (and its test)
```

The ETag cache in `github-git-data.ts` **stays in memory** (small, mutable
bodies) but gains a byte budget: cap total stored body bytes at
`ETAG_CACHE_MAX_BYTES` (default 8 MiB) and skip caching bodies over 256 KiB.
Entry-count cap stays as a secondary bound.

## Disk layout

```
$DECOFILE_CACHE_DIR/
  blobs/<owner>/<repo>/<blobSha>            raw block file content (bytes)
  merged/<owner>/<repo>/<headSha>.json      merged decofile document
  tmp/<random>/                             per-operation scratch (tar extract,
                                            atomic-write staging)
```

- `owner`/`repo` path segments are sanitized: lowercase, `[a-z0-9._-]` only,
  anything else percent-encoded. SHAs are validated `^[0-9a-f]{40}$` before
  path construction. No user-controlled string reaches a path un-sanitized.
- Writes are atomic: write to `tmp/`, `rename()` into place (same volume by
  construction). A crash never leaves a partial entry outside `tmp/`.
- Reads that lose a race with eviction (ENOENT mid-read) are cache misses.

## Limits (all env-tunable; defaults in parentheses)

| Env var | Default | Meaning |
| --- | --- | --- |
| `DECOFILE_CACHE_DIR` | `<os.tmpdir()>/studio-decofile-cache` | Root. Empty string disables the disk cache entirely (kill switch — requests then always fetch; single-flight still applies). |
| `DECOFILE_CACHE_MAX_BYTES` | 2 GiB | Total budget across `blobs/` + `merged/`. |
| `DECOFILE_CACHE_MERGED_MAX_BYTES` | 512 MiB | Sub-budget for `merged/` so many-tenant merged docs can't evict every blob. |
| `DECOFILE_CACHE_MAX_BLOB_BYTES` | 1 MiB | Admission cap for a single blob entry. Larger blobs are served but not cached. |
| `DECOFILE_CACHE_MAX_MERGED_BYTES` | 32 MiB | Admission cap for a single merged doc. |
| `DECOFILE_CACHE_FREE_FLOOR_BYTES` | 1 GiB | If `statfs` free space on the cache volume is below this, skip ALL cache writes (reads still served) and emit `decofile_cache_floor_skips`. |
| `DECOFILE_COLD_TARBALL_MAX_BYTES` | 128 MiB | Refuse the tarball path when the tree-derived `.deco/blocks` aggregate size exceeds this; fall back to bounded blob fetches. |
| `DECOFILE_CACHE_SWEEP_INTERVAL_MS` | 10 min | Reconciliation sweep (drift + `tmp/` orphans older than 1 h). |

Fixed (not env): tarball threshold stays `> 50` missing blobs; blob fetch
concurrency stays 12; GitHub compare/tree truncation guards stay as they are.

## Behaviors

### Index & budget (pure core: `cache-index.ts`)

An in-process map `relPath -> bytes` in LRU order plus counters per area
(blobs/merged). Pure API operating on plain data — no fs imports — so the unit
suite covers it without mocks:

```ts
createIndex(entries: Array<{ path: string; bytes: number; mtimeMs: number }>): CacheIndex
touch(index, path): void
admit(index, { path, bytes, area }): { admitted: boolean; evict: string[] }  // evict-then-write plan
remove(index, path): void
```

`admit` returns the eviction plan (oldest-first within the constraint set)
that makes room, or `admitted: false` when the entry violates an admission
cap. The fs shell (`disk-cache.ts`) executes the plan: delete files, update
index, then write. Startup: one recursive scan of the cache dir rebuilds the
index (mtime order approximates LRU across restarts); scan failures start
with an empty index and an empty dir.

### Warm read

`readDecofileSnapshot` order per (repo, head sha): merged disk hit → done
(serve bytes; do NOT JSON-parse). Miss → tree fetch (ETag'd) → per-blob disk
hits → only missing blobs from GitHub (concurrency 12) → write blobs + merged
through the store → serve. Identical GitHub request counts to today's
in-memory path, plus restart-warmness today's path lacks.

### Cold read (the tarball path)

When `missing > 50`:

1. **Pre-validate**: sum `size` of matching `.deco/blocks/*.json` entries from
   the already-fetched tree. Over `DECOFILE_COLD_TARBALL_MAX_BYTES` → skip to
   bounded blob fetches (log + metric; golden rule 3 beats golden rule 2 here).
2. **Stream**: `fetch` the tarball; pipe `res.body` directly into
   `Bun.spawn(["tar", "-xz", "--strip-components=1", "-C", scratchDir,
   "--wildcards", "*/.deco/blocks/*.json"])` stdin. The archive exists only as
   transit buffers; the child does the gunzip. Non-zero exit or spawn failure
   (no `tar` binary) → fall back to bounded blob fetches.
3. **Ingest**: read each extracted file (small by pre-validation), write blob
   entries through the store keyed by the tree's sha for that path, build the
   merged doc, write it through the store, delete `scratchDir` in `finally`.
4. **Single-flight**: the whole snapshot read is wrapped per
   `(owner/repo, sha)` — concurrent callers share one promise. This applies
   to warm reads too (cheap) but exists for the herd on cold reads.

### Sweeper

Every `DECOFILE_CACHE_SWEEP_INTERVAL_MS`: reconcile index vs disk (files
deleted externally, drift), enforce budget if drifted, remove `tmp/` dirs
older than 1 h. The sweeper is a backstop — write-time eviction is the primary
control. Runs with a jittered start; skips silently if the dir is gone.

### Failure handling

Every store operation catches and: returns miss (reads) or no-ops (writes),
increments `decofile_cache_errors{op}`, and on ENOSPC additionally triggers an
emergency eviction to 50% of budget. No store error propagates to a request.

## Observability

OTel gauges/counters (module-level meter, same pattern as existing
observability): `decofile_cache_bytes{area}`, `decofile_cache_entries{area}`,
`decofile_cache_hits{area}` / `_misses{area}`, `decofile_cache_evictions`,
`decofile_cache_errors{op}`, `decofile_cache_floor_skips`,
`decofile_cold_reads{path=tarball|blobs}`.

## Deploy

The chart/manifest (see `deploy/`) mounts a dedicated `emptyDir` at
`DECOFILE_CACHE_DIR` with `sizeLimit` ≥ 2× `DECOFILE_CACHE_MAX_BYTES`
(default: 4 GiB limit for the 2 GiB budget). Rationale: the volume wall keeps
a bug from filling the node, and the headroom keeps the kubelet's
pod-eviction enforcement dormant. Multi-replica pods each have their own
cache (correctness comes from content addressing, not sharing). Single
process per pod is assumed; the index is not multi-process safe.

## Testing

Two tiers, per TESTING.md — no third:

- **Unit** (`bun test`, co-located): `cache-index.ts` exhaustively (admission
  caps, evict-then-write plans, sub-budgets, LRU order from mtimes, path
  sanitization helpers, sha validation). Pure data in/out, no fs.
- **E2E** (`packages/e2e/tests/decofile-api.spec.ts`): the existing spec must
  pass unchanged — the cache is transparent at the HTTP contract. Add: (a) a
  second GET of the same head returns the identical body (exercises the
  merged-cache read path); (b) a cold read against the stub (which serves no
  tarballs) succeeds via the blob fallback. Do not assert on cache files —
  black-box suite.
- The `tar` subprocess path cannot run against the stub (no tarball
  endpoint); it is validated by the golden rules review + the live smoke
  against a real repo. Document this gap in the PR.

## Work breakdown (parallelizable)

1. **`cache-index.ts` + unit tests** — pure, no dependencies.
2. **`single-flight.ts` + unit tests** — pure, no dependencies.
3. **`disk-cache.ts`** (fs shell over 1) **+ `tar-extract.ts`** — depends on 1.
4. **Integration**: rewire `read-decofile.ts` / `commit-coalescer.ts` /
   `github-git-data.ts` (streaming tarball, `TreeEntry.size`), delete
   `tar.ts`, ETag byte cap, metrics, e2e additions — depends on 1–3.

Chunks 1–2 can run in parallel; 3 after 1; 4 last. Every chunk runs
`bun run fmt && bun run check && bun run lint` plus its tests; chunk 4 also
runs the full decofile unit suite and `knip`.
