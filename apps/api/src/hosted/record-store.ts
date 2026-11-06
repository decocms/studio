/**
 * The hosted CMS's private `record` bucket: what git used to hold for the
 * CMS, which is only the schema now.
 *
 *   sites/<site>/schema.json    the schema the last `deco schema push` sent
 *
 * `schema.json` is written with a plain PUT (the last deploy wins) and read
 * with a conditional GET on the ETag the reader cached, so an editor open
 * costs a 304 when the schema didn't change (contract §2.5). Only Studio
 * has credentials for this bucket; it is never public.
 */

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { getSettings } from "@/settings";
import { DeliveryUnavailableError } from "./delivery-store";

export type SchemaRead =
  | { notModified: true; etag: string }
  | { notModified: false; text: string; etag: string | null };

export interface RecordStore {
  /** Plain PUT of the schema's bytes; returns its ETag. */
  putSchema(site: string, text: string): Promise<{ etag: string | null }>;
  /**
   * The schema, or null when no deploy pushed one. With `ifNoneMatch` (the
   * cached copy's ETag), an unchanged schema answers `notModified`.
   */
  getSchema(
    site: string,
    ifNoneMatch?: string | null,
  ): Promise<SchemaRead | null>;
}

function recordKeys(prefix = getSettings().recordKeyPrefix ?? "") {
  return {
    schema: (site: string) => {
      if (!isValidSiteSlug(site)) throw new Error(`invalid site id: ${site}`);
      return `${prefix}sites/${site}/schema.json`;
    },
  };
}

function status(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata
    ?.httpStatusCode;
}

function createS3RecordStore(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  keyPrefix?: string;
}): RecordStore {
  const client = new S3Client({
    endpoint: config.endpoint,
    region: "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  });
  const Bucket = config.bucket;
  const keys = recordKeys(config.keyPrefix ?? "");
  return {
    async putSchema(site, text) {
      const Key = keys.schema(site);
      try {
        const res = await client.send(
          new PutObjectCommand({
            Bucket,
            Key,
            Body: Buffer.from(text, "utf-8"),
            ContentType: "application/json; charset=utf-8",
          }),
        );
        return { etag: res.ETag ?? null };
      } catch (error) {
        throw new DeliveryUnavailableError(Key, error);
      }
    },
    async getSchema(site, ifNoneMatch) {
      const Key = keys.schema(site);
      try {
        const res = await client.send(
          new GetObjectCommand({
            Bucket,
            Key,
            ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
          }),
        );
        return {
          notModified: false,
          text: (await res.Body?.transformToString("utf-8")) ?? "",
          etag: res.ETag ?? null,
        };
      } catch (error) {
        const code = status(error);
        if (code === 304 && ifNoneMatch) {
          return { notModified: true, etag: ifNoneMatch };
        }
        if (
          code === 404 ||
          (error as { name?: string })?.name === "NoSuchKey"
        ) {
          return null;
        }
        throw new DeliveryUnavailableError(Key, error);
      }
    },
  };
}

let cached: RecordStore | null | undefined;

/**
 * The configured record bucket, or null when this Studio has none. Its
 * endpoint and key default to the delivery bucket's (one R2 account).
 */
export function recordStore(): RecordStore | null {
  if (cached !== undefined) return cached;
  const s = getSettings();
  const endpoint =
    s.recordR2Endpoint ??
    s.deliveryR2Endpoint ??
    (s.deliveryR2AccountId
      ? `https://${s.deliveryR2AccountId}.r2.cloudflarestorage.com`
      : undefined);
  const accessKeyId = s.recordR2AccessKeyId ?? s.deliveryR2AccessKeyId;
  const secretAccessKey =
    s.recordR2SecretAccessKey ?? s.deliveryR2SecretAccessKey;
  cached =
    endpoint && s.recordR2Bucket && accessKeyId && secretAccessKey
      ? createS3RecordStore({
          endpoint,
          bucket: s.recordR2Bucket,
          accessKeyId,
          secretAccessKey,
          keyPrefix: s.recordKeyPrefix ?? "",
        })
      : null;
  return cached;
}
