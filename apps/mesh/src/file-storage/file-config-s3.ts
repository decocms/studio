/**
 * S3 client built from a resolved org file config. Unlike the shared
 * `object-storage/S3Service`, this client does NOT inject any per-org key
 * prefix — the prefix configured on the file config itself is the only
 * namespace. Each call site owns its own client because credentials are
 * different per config and the SDK client caches the signer.
 */

import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type {
  FileConfigCredentials,
  OrgFileConfigStorage,
} from "../storage/org-file-configs";
import type { FileConfigInfo } from "../storage/types";

export interface FileConfigContext {
  info: FileConfigInfo;
  credentials: FileConfigCredentials;
}

function buildS3Client(ctx: FileConfigContext): S3Client {
  return new S3Client({
    region: ctx.info.region,
    endpoint: ctx.info.endpoint ?? undefined,
    forcePathStyle: ctx.info.forcePathStyle,
    credentials: {
      accessKeyId: ctx.credentials.accessKeyId,
      secretAccessKey: ctx.credentials.secretAccessKey,
    },
    // GCS, R2, and MinIO don't all honor the `x-amz-checksum-*` headers
    // AWS SDK v3 auto-injects. Disable unless an operation explicitly
    // requires them.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
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

export async function resolveFileConfig(
  storage: OrgFileConfigStorage,
  id: string,
  organizationId: string,
): Promise<FileConfigContext> {
  return storage.resolveById(id, organizationId);
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
 * S3 ListObjectsV2 only returns keys in lexicographic order — there's no
 * "filter / sort by lastModified" server-side. Our upload key format is
 * `<configured-prefix>/<yyyy>/<mm>/<uuid>-<filename>`, so to give the
 * picker a "recent first" feel we:
 *
 *   1. List under `<prefix><currentYear>/` first — every upload from this
 *      year is captured here, no matter what historical UUID-first keys
 *      live alongside.
 *   2. If we still have room in the page, list under `<prefix><prevYear>/`.
 *   3. Finally, list under the broad prefix as a fallback for legacy
 *      objects that don't follow our date sharding.
 *
 * Results are merged, de-duped by key, sorted by lastModified DESC, and
 * truncated to `maxKeys`. Cursor pagination is only used on the broad
 * fallback list — once the user pages past the "recent" buckets we
 * iterate the whole namespace lexicographically (the only thing S3
 * offers).
 */
export async function listObjects(params: {
  ctx: FileConfigContext;
  cursor?: string | null;
  maxKeys?: number;
}): Promise<ListObjectsResult> {
  const client = buildS3Client(params.ctx);
  const target = Math.min(params.maxKeys ?? 50, 200);
  const bucketPrefix = params.ctx.info.prefix ?? "";

  const now = new Date();
  const currentYear = String(now.getUTCFullYear());
  const prevYear = String(now.getUTCFullYear() - 1);

  const yearShardPrefixes = [
    `${bucketPrefix}${currentYear}/`,
    `${bucketPrefix}${prevYear}/`,
  ];

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
    return finalize(response, params.ctx, target, false, yearShardPrefixes);
  }

  const probes = yearShardPrefixes;

  const seen = new Map<string, ListedObject>();
  for (const prefix of probes) {
    if (seen.size >= target) break;
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: params.ctx.info.bucket,
        Prefix: prefix,
        MaxKeys: target - seen.size,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/") || seen.has(obj.Key)) continue;
      seen.set(obj.Key, toListedObject(obj, params.ctx));
    }
  }

  // Fallback: walk the broad prefix to top up legacy objects (existing
  // deco-CMS files that don't have the yyyy/mm shard).
  let nextCursor: string | null = null;
  if (seen.size < target) {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: params.ctx.info.bucket,
        Prefix: bucketPrefix || undefined,
        MaxKeys: target - seen.size,
      }),
    );
    for (const obj of res.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/") || seen.has(obj.Key)) continue;
      seen.set(obj.Key, toListedObject(obj, params.ctx));
    }
    nextCursor = res.IsTruncated ? (res.NextContinuationToken ?? null) : null;
  }

  const items = Array.from(seen.values()).sort(byLastModifiedDesc);
  return { items, nextCursor };
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

function byLastModifiedDesc(a: ListedObject, b: ListedObject): number {
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
