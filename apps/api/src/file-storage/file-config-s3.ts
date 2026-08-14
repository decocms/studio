/**
 * S3 client built from a resolved org file config. Unlike the shared
 * `object-storage/S3Service`, this client does NOT inject any per-org key
 * prefix — the prefix configured on the file config itself is the only
 * namespace. Clients are cached per config (see `buildS3Client`) so the SDK's
 * signer and — for `sts-session` configs — its credential memoization persist
 * across requests.
 */

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type {
  FileConfigCredentials,
  OrgFileConfigStorage,
} from "../storage/org-file-configs";
import type { OrgSiteStoragePort } from "../storage/ports";
import type { FileConfigInfo } from "../storage/types";
import { provisionTenantS3Credentials } from "./tenant-credentials";
import { monthShardSegment } from "./upload-policy";

export interface FileConfigContext {
  info: FileConfigInfo;
  credentials: FileConfigCredentials;
}

/** Shape the AWS SDK accepts as a resolved credential identity. */
interface ResolvedCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiration?: Date;
}

/**
 * For an `sts-session` config, returns an async credential provider instead of
 * a static key pair. The AWS SDK memoizes the provider's result and re-invokes
 * it once the returned `expiration` is near, so temporary credentials refresh
 * automatically — as long as the owning `S3Client` instance is reused (see the
 * client cache below). Each call fetches fresh creds from the config's
 * `refreshUrl`, authenticating with the stored API key.
 */
export function stsCredentialProvider(
  info: FileConfigInfo,
  apiKey: string,
): () => Promise<ResolvedCredentials> {
  const url = info.refreshUrl;
  if (!url) {
    throw new Error(
      `sts-session file config ${info.id} is missing a refreshUrl`,
    );
  }
  return async () => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `sts refresh failed (${res.status}) for file config ${info.id}: ${body.slice(0, 200)}`,
      );
    }
    const data = (await res.json()) as {
      accessKeyId?: string;
      secretAccessKey?: string;
      sessionToken?: string;
      expiration?: string;
    };
    if (!data.accessKeyId || !data.secretAccessKey || !data.sessionToken) {
      throw new Error(
        `sts refresh returned incomplete credentials for file config ${info.id}`,
      );
    }
    return {
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
      sessionToken: data.sessionToken,
      expiration: data.expiration ? new Date(data.expiration) : undefined,
    };
  };
}

// S3Client instances are cached so the SDK's credential memoization survives
// across requests — critical for `sts-session` configs, where a fresh client
// per request would re-fetch temporary creds every single time instead of
// refreshing only near expiry. Keyed by config id + updatedAt so any change
// to the config (incl. credential rotation) transparently busts the entry.
const CLIENT_CACHE_MAX = 256;
const clientCache = new Map<string, S3Client>();

export function buildS3Client(ctx: FileConfigContext): S3Client {
  const cacheKey = `${ctx.info.id}:${ctx.info.updatedAt}`;
  const cached = clientCache.get(cacheKey);
  if (cached) return cached;

  const credentials =
    ctx.credentials.type === "sts-session"
      ? stsCredentialProvider(ctx.info, ctx.credentials.apiKey)
      : ctx.credentials.type === "managed"
        ? // Mint prefix-scoped STS creds in-process for the config's slug. The
          // SDK memoizes/refreshes by expiration, same as the sts-session path.
          () => provisionTenantS3Credentials(ctx.info.siteSlug ?? "")
        : {
            accessKeyId: ctx.credentials.accessKeyId,
            secretAccessKey: ctx.credentials.secretAccessKey,
          };

  const client = new S3Client({
    region: ctx.info.region,
    endpoint: ctx.info.endpoint ?? undefined,
    forcePathStyle: ctx.info.forcePathStyle,
    credentials,
    // GCS, R2, and MinIO don't all honor the `x-amz-checksum-*` headers
    // AWS SDK v3 auto-injects. Disable unless an operation explicitly
    // requires them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });

  if (clientCache.size >= CLIENT_CACHE_MAX) {
    const oldest = clientCache.keys().next().value;
    if (oldest !== undefined) clientCache.delete(oldest);
  }
  clientCache.set(cacheKey, client);
  return client;
}

/**
 * Build the public URL a browser will use to GET the object. When
 * `publicUrlBase` is set on the config, prefer it (R2 dev domain, CDN,
 * custom host). Otherwise compute the canonical AWS S3 URL. Buckets behind
 * an `endpoint` *without* a `publicUrlBase` aren't actually publicly
 * addressable (R2 default, MinIO) — we return the endpoint URL as a
 * best-effort, but the user should configure `publicUrlBase` for those.
 */
export function buildPublicUrl(info: FileConfigInfo, key: string): string {
  if (info.publicUrlBase) {
    return `${info.publicUrlBase}/${encodeKey(key)}`;
  }
  if (info.endpoint) {
    // Always path-style for custom endpoints. Virtual-host style is
    // provider-specific (e.g. R2 dev domains, MinIO subdomain mode) and
    // not derivable from `endpoint + bucket`. Callers that want a
    // virtual-host or CDN URL should set `publicUrlBase` explicitly.
    const base = info.endpoint.replace(/\/+$/, "");
    return `${base}/${info.bucket}/${encodeKey(key)}`;
  }
  return info.forcePathStyle
    ? `https://s3.${info.region}.amazonaws.com/${info.bucket}/${encodeKey(key)}`
    : `https://${info.bucket}.s3.${info.region}.amazonaws.com/${encodeKey(key)}`;
}

function encodeKey(key: string): string {
  // Encode each path segment so slashes survive (S3 paths use `/`), but
  // spaces and unicode get percent-encoded for browsers.
  return key.split("/").map(encodeURIComponent).join("/");
}

/** Thrown when an org tries to use a managed config for a slug it doesn't own. */
export class FileConfigForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileConfigForbiddenError";
  }
}

export async function resolveFileConfig(
  storage: OrgFileConfigStorage,
  orgSites: OrgSiteStoragePort,
  id: string,
  organizationId: string,
): Promise<FileConfigContext> {
  const ctx = await storage.resolveById(id, organizationId);
  // Fail-closed: a `managed` config may only be used by the org that owns the
  // site slug it mints for. This is the single choke point — every entry point
  // (upload route, list tool) resolves through here, so the ownership check
  // can't be bypassed regardless of which caller resolves the config.
  if (ctx.info.credentialType === "managed") {
    const slug = ctx.info.siteSlug;
    if (!slug || !(await orgSites.isOwnedBy(slug, organizationId))) {
      throw new FileConfigForbiddenError(
        `Organization does not own site "${slug ?? "(none)"}" for managed file config ${id}`,
      );
    }
  }
  return ctx;
}

export interface ListedObject {
  key: string;
  size: number;
  lastModified: string | null;
  publicUrl: string;
}

export interface ListObjectsResult {
  items: ListedObject[];
  nextCursor: string | null;
}

/**
 * How many month shards page 1 walks back, newest first, before the broad
 * lexicographic fallback. Wide enough to surface recent uploads in buckets
 * quiet for a few months; each is enumerated in full and the merged set is
 * sorted by lastModified, then truncated to the page size.
 */
const MONTH_SHARD_PROBES = 6;

/**
 * Safety cap on pages (1000 keys each) enumerated per month shard. A month is
 * listed in full so sorting by lastModified yields a true newest-first order
 * (a single capped LIST returns UUID-lexicographic order, hiding the freshest
 * upload behind older ones). This bounds the work if a single month ever holds
 * a pathological number of objects; realistic image buckets stay well under
 * one page.
 */
const MONTH_SHARD_MAX_PAGES = 5;

/**
 * Month-shard key prefixes to probe, newest first: `<bucketPrefix><yyyy>/<mm>/`
 * for the current month walking back `count` months, crossing year boundaries
 * (`2026/01/` -> `2025/12/`). Shares `monthShardSegment` with `buildObjectKey`
 * so a fresh upload is always fetched by its month's probe instead of being
 * truncated behind older months in a year-wide lexicographic listing.
 */
export function monthShardPrefixes(
  bucketPrefix: string,
  now: Date,
  count: number,
): string[] {
  const prefixes: string[] = [];
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth() + 1; // 1-12
  for (let i = 0; i < count; i++) {
    prefixes.push(`${bucketPrefix}${monthShardSegment(year, month)}`);
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  return prefixes;
}

/** Raw S3 object fields the listing helpers reason about. */
type RawS3Object = { Key?: string; Size?: number; LastModified?: Date };

/**
 * Enumerate every object directly under `prefix`, paginating up to `maxPages`
 * pages of 1000. Listing the shard in full (rather than one capped LIST) is
 * what lets the caller sort by lastModified into a true newest-first order — a
 * single page comes back in UUID-lexicographic order, which buries the freshest
 * upload behind older keys in a busy month.
 */
async function listAllUnderPrefix(
  client: S3Client,
  bucket: string,
  prefix: string,
  maxPages: number,
): Promise<RawS3Object[]> {
  const out: RawS3Object[] = [];
  let token: string | undefined;
  let pages = 0;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 1000,
        ContinuationToken: token,
      }),
    );
    for (const obj of res.Contents ?? []) out.push(obj);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    pages += 1;
  } while (token && pages < maxPages);
  return out;
}

/**
 * List a page of bucket objects, newest first. S3 ListObjectsV2 sorts only
 * lexicographically, so page 1 enumerates the newest month shard in full (see
 * `monthShardPrefixes` / `listAllUnderPrefix`), walking back to older months
 * only if it doesn't fill the page, plus a broad-prefix fallback for legacy
 * keys and the continuation token; results are merged, de-duped, sorted by
 * lastModified DESC, and truncated to the page size. Cursor pages walk the
 * broad namespace in S3's lexicographic key order (older objects first, NOT
 * re-sorted by lastModified), skipping the month shards page 1 already returned.
 */
export async function listObjects(params: {
  ctx: FileConfigContext;
  cursor?: string | null;
  maxKeys?: number;
  search?: string | null;
  imageOnly?: boolean;
}): Promise<ListObjectsResult> {
  const client = buildS3Client(params.ctx);
  const target = Math.min(params.maxKeys ?? 50, 200);
  const bucketPrefix = params.ctx.info.prefix ?? "";

  // Search is a substring match on the object key. S3 ListObjectsV2 only
  // filters by lexicographic prefix, and our keys embed the filename after
  // a `<yyyy>/<mm>/<uuid>-` shard, so a prefix query can't find it. The only
  // option is to scan pages under the broad prefix and filter server-side.
  const search = params.search?.trim().toLowerCase();
  if (search) {
    return searchObjects({
      client,
      ctx: params.ctx,
      bucketPrefix,
      target,
      cursor: params.cursor,
      search,
      imageOnly: params.imageOnly ?? false,
    });
  }

  const monthShardPrefixesList = monthShardPrefixes(
    bucketPrefix,
    new Date(),
    MONTH_SHARD_PROBES,
  );

  // Subsequent pages walk the broad namespace via continuation token —
  // skip the date-shard probes (already returned on page 1) and filter
  // any keys under those prefixes out of the response so we don't
  // duplicate what page 1 already showed.
  if (params.cursor) {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: params.ctx.info.bucket,
        Prefix: bucketPrefix || undefined,
        MaxKeys: target,
        ContinuationToken: params.cursor,
      }),
    );
    return finalize(
      response,
      params.ctx,
      target,
      false,
      monthShardPrefixesList,
    );
  }

  const seen = new Map<string, ListedObject>();
  const absorb = (objs: RawS3Object[]) => {
    for (const obj of objs) {
      if (!obj.Key || obj.Key.endsWith("/") || seen.has(obj.Key)) continue;
      seen.set(obj.Key, toListedObject(obj, params.ctx));
    }
  };

  // Newest month first; every key in it outranks any older month, so we only walk back if it doesn't fill the page.
  const [newestMonth, ...olderMonths] = monthShardPrefixesList;
  if (newestMonth) {
    absorb(
      await listAllUnderPrefix(
        client,
        params.ctx.info.bucket,
        newestMonth,
        MONTH_SHARD_MAX_PAGES,
      ),
    );
  }
  if (seen.size < target && olderMonths.length > 0) {
    // Fan the remaining months out concurrently — we already know we need them.
    const older = await Promise.all(
      olderMonths.map((prefix) =>
        listAllUnderPrefix(
          client,
          params.ctx.info.bucket,
          prefix,
          MONTH_SHARD_MAX_PAGES,
        ),
      ),
    );
    for (const objs of older) absorb(objs);
  }

  // Runs unconditionally to expose nextCursor and reach legacy/older keys not under the month shards.
  const broadMaxKeys = Math.max(1, target - seen.size);
  const broadRes = await client.send(
    new ListObjectsV2Command({
      Bucket: params.ctx.info.bucket,
      Prefix: bucketPrefix || undefined,
      MaxKeys: broadMaxKeys,
    }),
  );
  for (const obj of broadRes.Contents ?? []) {
    if (seen.size >= target) break;
    if (!obj.Key || obj.Key.endsWith("/") || seen.has(obj.Key)) continue;
    // Month-shard keys were already pulled via dedicated probes; skip to avoid duping.
    if (monthShardPrefixesList.some((p) => obj.Key!.startsWith(p))) continue;
    seen.set(obj.Key, toListedObject(obj, params.ctx));
  }
  const nextCursor = broadRes.IsTruncated
    ? (broadRes.NextContinuationToken ?? null)
    : null;

  // Full-month enumeration over-fetches, so sort by recency and keep one page.
  const items = Array.from(seen.values())
    .sort(byLastModifiedDesc)
    .slice(0, target);
  return { items, nextCursor };
}

/**
 * Image key extensions the pickers treat as images. This MIRRORS the
 * client-side `isImageKey` in `web/components/file-picker/file-picker-dialog.tsx`
 * — keep the two extension lists in sync. Filtering server-side (see
 * `searchObjects`) matters for search: without it the scan matches non-image
 * keys the image picker then discards, so a text match on `report.pdf` would
 * show "no matches" and waste scan budget on rows the client throws away.
 */
const IMAGE_KEY_RE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;

export function isImageKey(key: string): boolean {
  return IMAGE_KEY_RE.test(key);
}

/** Minimal object shape the pure scan helpers reason about. */
export interface ScanCandidate {
  key: string;
  size: number;
  lastModified: string | null;
}

/**
 * Pure: keep the candidates on one scanned page whose lowercased key contains
 * `search` (and, when `imageOnly`, that look like images). Folder markers
 * (keys ending in `/`) are dropped by the caller before this runs.
 */
export function matchScanPage(
  candidates: ScanCandidate[],
  search: string,
  imageOnly: boolean,
): ScanCandidate[] {
  return candidates.filter(
    (c) =>
      c.key.toLowerCase().includes(search) && (!imageOnly || isImageKey(c.key)),
  );
}

/**
 * Pure: decide whether the scan loop should stop after consuming a page and
 * what cursor to hand back. The loop stops once it has enough matches, the
 * bucket is exhausted, or it hits the per-request page budget. `nextCursor` is
 * the page-boundary token only while more unscanned keys remain — so "Load
 * more" resumes exactly where this call stopped, never dropping matches.
 */
export function nextScanStep(params: {
  matchCount: number;
  target: number;
  pagesScanned: number;
  maxPages: number;
  isTruncated: boolean;
  continuationToken: string | undefined;
}): { done: boolean; nextCursor: string | null } {
  const hasMore = Boolean(params.isTruncated && params.continuationToken);
  const done =
    params.matchCount >= params.target ||
    !hasMore ||
    params.pagesScanned >= params.maxPages;
  return {
    done,
    nextCursor: hasMore ? (params.continuationToken ?? null) : null,
  };
}

/**
 * Substring search over the bucket. S3 gives us no server-side "contains"
 * filter, so we scan wide pages (up to `SCAN_PAGE_SIZE` keys each) under the
 * broad prefix and keep matching keys (see `matchScanPage`). A thin I/O shell:
 * the match filter and the stop/cursor decision live in the pure `matchScanPage`
 * / `nextScanStep` helpers so they're unit-testable without S3.
 *
 * Each request scans at most `MAX_SCAN_PAGES` pages so a huge bucket can't
 * stall a single call — the returned cursor lets the client continue if the
 * target wasn't reached.
 */
async function searchObjects(params: {
  client: S3Client;
  ctx: FileConfigContext;
  bucketPrefix: string;
  target: number;
  cursor?: string | null;
  search: string;
  imageOnly: boolean;
}): Promise<ListObjectsResult> {
  const SCAN_PAGE_SIZE = 1000;
  const MAX_SCAN_PAGES = 20;

  const matches: ScanCandidate[] = [];
  let continuationToken = params.cursor ?? undefined;
  let pagesScanned = 0;
  let step: { done: boolean; nextCursor: string | null } = {
    done: false,
    nextCursor: null,
  };

  do {
    const res = await params.client.send(
      new ListObjectsV2Command({
        Bucket: params.ctx.info.bucket,
        Prefix: params.bucketPrefix || undefined,
        MaxKeys: SCAN_PAGE_SIZE,
        ContinuationToken: continuationToken,
      }),
    );
    pagesScanned++;

    const candidates: ScanCandidate[] = [];
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue;
      candidates.push({
        key: obj.Key,
        size: obj.Size ?? 0,
        lastModified: obj.LastModified ? obj.LastModified.toISOString() : null,
      });
    }
    matches.push(...matchScanPage(candidates, params.search, params.imageOnly));

    step = nextScanStep({
      matchCount: matches.length,
      target: params.target,
      pagesScanned,
      maxPages: MAX_SCAN_PAGES,
      isTruncated: Boolean(res.IsTruncated),
      continuationToken: res.NextContinuationToken,
    });
    continuationToken = res.NextContinuationToken;
  } while (!step.done);

  const items: ListedObject[] = matches
    .map((c) => ({ ...c, publicUrl: buildPublicUrl(params.ctx.info, c.key) }))
    .sort(byLastModifiedDesc);
  return { items, nextCursor: step.nextCursor };
}

function toListedObject(
  obj: { Key?: string; Size?: number; LastModified?: Date },
  ctx: FileConfigContext,
): ListedObject {
  return {
    key: obj.Key!,
    size: obj.Size ?? 0,
    lastModified: obj.LastModified ? obj.LastModified.toISOString() : null,
    publicUrl: buildPublicUrl(ctx.info, obj.Key!),
  };
}

export function byLastModifiedDesc(a: ListedObject, b: ListedObject): number {
  // Nulls sink to the bottom.
  if (!a.lastModified && !b.lastModified) return 0;
  if (!a.lastModified) return 1;
  if (!b.lastModified) return -1;
  return b.lastModified.localeCompare(a.lastModified);
}

function finalize(
  response: {
    Contents?: Array<{ Key?: string; Size?: number; LastModified?: Date }>;
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  },
  ctx: FileConfigContext,
  target: number,
  sort: boolean,
  skipPrefixes: readonly string[] = [],
): ListObjectsResult {
  const items = (response.Contents ?? [])
    .filter(
      (obj) =>
        obj.Key &&
        !obj.Key.endsWith("/") &&
        !skipPrefixes.some((p) => obj.Key!.startsWith(p)),
    )
    .slice(0, target)
    .map((obj) => toListedObject(obj, ctx));
  if (sort) items.sort(byLastModifiedDesc);
  return {
    items,
    nextCursor: response.IsTruncated
      ? (response.NextContinuationToken ?? null)
      : null,
  };
}
