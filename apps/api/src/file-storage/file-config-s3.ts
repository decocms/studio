/**
 * S3 client built from a resolved org file config. Unlike the shared
 * `object-storage/S3Service`, this client does NOT inject any per-org key
 * prefix — the prefix configured on the file config itself is the only
 * namespace. Clients are cached per config (see `buildS3Client`) so the SDK's
 * signer and — for `sts-session` configs — its credential memoization persist
 * across requests.
 */

import {
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  FileConfigCredentials,
  OrgFileConfigStorage,
} from "../storage/org-file-configs";
import type { OrgSiteStoragePort } from "../storage/ports";
import type { FileConfigInfo } from "../storage/types";
import { provisionTenantS3Credentials } from "./tenant-credentials";

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
    const expiration = data.expiration ? new Date(data.expiration) : undefined;
    if (expiration && Number.isNaN(expiration.getTime())) {
      throw new Error(
        `sts refresh returned an invalid expiration for file config ${info.id}: ${data.expiration}`,
      );
    }
    return {
      accessKeyId: data.accessKeyId,
      secretAccessKey: data.secretAccessKey,
      sessionToken: data.sessionToken,
      expiration,
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

  // Validate required configuration fields before passing to AWS SDK
  if (!ctx.info.region) {
    throw new Error(`File config ${ctx.info.id} missing or empty region`);
  }
  if (!ctx.info.bucket) {
    throw new Error(`File config ${ctx.info.id} missing or empty bucket`);
  }

  const credentials =
    ctx.credentials.type === "sts-session"
      ? stsCredentialProvider(ctx.info, ctx.credentials.apiKey)
      : ctx.credentials.type === "managed"
        ? (() => {
            // Validate siteSlug for managed credentials
            const slug = ctx.info.siteSlug;
            if (!slug) {
              throw new Error(
                `Managed file config ${ctx.info.id} missing siteSlug`,
              );
            }
            return () => provisionTenantS3Credentials(slug);
          })()
        : (() => {
            // Validate static credentials before passing to AWS SDK
            if (!ctx.credentials.accessKeyId) {
              throw new Error(
                `File config ${ctx.info.id} missing or empty accessKeyId`,
              );
            }
            if (!ctx.credentials.secretAccessKey) {
              throw new Error(
                `File config ${ctx.info.id} missing or empty secretAccessKey`,
              );
            }
            return {
              accessKeyId: ctx.credentials.accessKeyId,
              secretAccessKey: ctx.credentials.secretAccessKey,
            };
          })();

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

/**
 * Delete a single object from a configured bucket. The `key` is the raw S3
 * key (not URL-encoded) as returned by {@link listObjects}. Deleting a
 * non-existent key is a no-op on S3 (returns 204), so this is idempotent.
 */
export async function deleteObject(params: {
  ctx: FileConfigContext;
  key: string;
}): Promise<void> {
  const client = buildS3Client(params.ctx);
  await client.send(
    new DeleteObjectCommand({
      Bucket: params.ctx.info.bucket,
      Key: params.key,
    }),
  );
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

/** Page cap (1000 keys each) for the full-prefix enumerate-then-sort listing; bounds work on huge buckets at ~50k keys. */
const LIST_MAX_PAGES = 50;

/** Raw S3 object fields the listing helpers reason about. */
type RawS3Object = { Key?: string; Size?: number; LastModified?: Date };

/** Pure: parse the pagination cursor into a zero-based offset into the recency-sorted set; unparseable/non-positive → 0. */
export function parseOffsetCursor(cursor?: string | null): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Enumerate every object under `prefix` (empty = whole bucket), up to `maxPages` pages of 1000, so the caller can sort by lastModified. */
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
        Prefix: prefix || undefined,
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
 * List a page of bucket objects, newest first. S3 sorts only lexicographically
 * (never by upload recency, for any key layout), so we enumerate the whole
 * prefix (bounded by `LIST_MAX_PAGES`), sort by lastModified DESC, and paginate
 * in memory via an offset cursor (`parseOffsetCursor`), not an S3 token.
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

  const raw = await listAllUnderPrefix(
    client,
    params.ctx.info.bucket,
    bucketPrefix,
    LIST_MAX_PAGES,
  );
  const sorted = raw
    .filter((obj) => obj.Key && !obj.Key.endsWith("/"))
    .map((obj) => toListedObject(obj, params.ctx))
    .sort(byLastModifiedDesc);

  const offset = parseOffsetCursor(params.cursor);
  const items = sorted.slice(offset, offset + target);
  const nextOffset = offset + items.length;
  const nextCursor = nextOffset < sorted.length ? String(nextOffset) : null;
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
