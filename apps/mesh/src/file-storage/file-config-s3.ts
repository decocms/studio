/**
 * S3 client built from a resolved org file config. Unlike the shared
 * `object-storage/S3Service`, this client does NOT inject any per-org key
 * prefix — the prefix configured on the file config itself is the only
 * namespace. Each call site owns its own client because credentials are
 * different per config and the SDK client caches the signer.
 */

import {
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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
    const base = info.endpoint.replace(/\/+$/, "");
    return info.forcePathStyle
      ? `${base}/${info.bucket}/${encodeKey(key)}`
      : // virtual-host style with custom endpoint is unusual; fall back to
        // path-style so the URL at least *resolves* even if not public.
        `${base}/${info.bucket}/${encodeKey(key)}`;
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

export async function presignPutUrl(params: {
  ctx: FileConfigContext;
  key: string;
  contentType: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const client = buildS3Client(params.ctx);
  return getSignedUrl(
    client,
    new PutObjectCommand({
      Bucket: params.ctx.info.bucket,
      Key: params.key,
      ContentType: params.contentType,
    }),
    { expiresIn: params.expiresInSeconds ?? 300 },
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

export async function listObjects(params: {
  ctx: FileConfigContext;
  cursor?: string | null;
  maxKeys?: number;
}): Promise<ListObjectsResult> {
  const client = buildS3Client(params.ctx);
  const response = await client.send(
    new ListObjectsV2Command({
      Bucket: params.ctx.info.bucket,
      Prefix: params.ctx.info.prefix ?? undefined,
      MaxKeys: Math.min(params.maxKeys ?? 50, 200),
      ContinuationToken: params.cursor ?? undefined,
    }),
  );

  const items = (response.Contents ?? [])
    .filter((obj) => obj.Key && !obj.Key.endsWith("/"))
    .map((obj) => ({
      key: obj.Key!,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified ? obj.LastModified.toISOString() : null,
      publicUrl: buildPublicUrl(params.ctx.info, obj.Key!),
    }));

  return {
    items,
    nextCursor: response.IsTruncated
      ? (response.NextContinuationToken ?? null)
      : null,
  };
}
