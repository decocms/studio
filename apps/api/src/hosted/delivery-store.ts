/**
 * The hosted Deco CMS delivery bucket: an R2 bucket served read-only at
 * `https://delivery.decocms.com`, written by Studio through R2's S3 API.
 *
 *   sites/<site>/latest.json                     { revision, previewHosts }
 *   sites/<site>/revisions/<id>/data.json        { blocks }
 *   sites/<site>/revisions/<id>/meta.json        { previous, draft?, reapplyOf?, author, via, message, publishedAt }
 *   sites/<site>/drafts/<slug>.json              { set, delete, editors }
 *
 * Keys are only ever built here, from a validated site slug, revision id or
 * draft slug, so no caller can address anything
 * outside its site's prefix. Every key starts with the `DELIVERY_KEY_PREFIX`
 * setting (test-only, empty in production).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { getSettings } from "@/settings";
import { isRevisionId } from "./revision-id";

export const DELIVERY_ORIGIN = "https://delivery.decocms.com";

/** 16 random bytes, base64url without padding. */
const DRAFT_SLUG_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The edge holds latest.json up to 1 h (purged after every write); browsers
 * and servers revalidate on every read, so no unchecked stale pointer is used.
 */
export const CACHE_LATEST = "public, max-age=0, s-maxage=3600, must-revalidate";
export const CACHE_REVISION = "public, max-age=31536000, immutable";
export const CACHE_DRAFT = "no-cache, max-age=0, must-revalidate";

/** The test-only key prefix (`DELIVERY_KEY_PREFIX`), `""` in production. */
function keyPrefix(): string {
  return getSettings().deliveryKeyPrefix ?? "";
}

function siteKey(site: string): string {
  if (!isValidSiteSlug(site)) throw new Error(`invalid site id: ${site}`);
  return `${keyPrefix()}sites/${site}`;
}

function revisionFolder(site: string, id: string): string {
  if (!isRevisionId(id)) throw new Error(`invalid revision: ${id}`);
  return `${siteKey(site)}/revisions/${id}/`;
}

export const deliveryKeys = {
  latest: (site: string) => `${siteKey(site)}/latest.json`,
  revisions: (site: string) => `${siteKey(site)}/revisions/`,
  /** A revision's blocks (immutable): `revisions/<id>/data.json`. */
  revisionData: (site: string, id: string) =>
    `${revisionFolder(site, id)}data.json`,
  /** A revision's meta (immutable): `revisions/<id>/meta.json`. */
  revisionMeta: (site: string, id: string) =>
    `${revisionFolder(site, id)}meta.json`,
  draft: (site: string, slug: string) => {
    if (!DRAFT_SLUG_RE.test(slug)) throw new Error("invalid draft slug");
    return `${siteKey(site)}/drafts/${slug}.json`;
  },
};

/** A new draft slug: unguessable, since holding its URL is the read grant. */
export function newDraftSlug(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
    "base64url",
  );
}

/** An ETag without its quotes (and weak prefix), as the draft pointer carries it. */
export function bareEtag(etag: string | null | undefined): string | null {
  if (!etag) return null;
  return etag.replace(/^W\//, "").replace(/^"|"$/g, "");
}

export interface StoredObject {
  text: string;
  etag: string | null;
}

/**
 * A write that lands only while the object is as the writer last read it:
 * still at `ifMatch` (its ETag), or, with `ifNoneMatch: "*"`, still absent.
 */
export type PutCondition = { ifMatch: string } | { ifNoneMatch: "*" };

/**
 * A conditional write found the object changed since it was read (S3 412
 * `PreconditionFailed`, or 409 `ConditionalRequestConflict` while another
 * write of it lands): nothing was written; read it again and retry.
 */
export class ObjectChangedError extends Error {
  constructor(key: string) {
    super(`${key} changed while it was being written`);
    this.name = "ObjectChangedError";
  }
}

/**
 * R2 couldn't answer a write or read now: a 429, a 5xx, a network error or
 * a timeout. On a conditional PUT this is never a lost race and never a
 * success (contract §2.6): the caller answers Unavailable and nothing is
 * retried here.
 */
export class DeliveryUnavailableError extends Error {
  constructor(key: string, cause: unknown) {
    super(
      `${key}: the delivery bucket is unavailable (${
        cause instanceof Error ? cause.message : String(cause)
      })`,
    );
    this.name = "DeliveryUnavailableError";
  }
}

/** One page of a delimiter listing: the common prefixes ("folders"). */
export interface ListPage {
  prefixes: string[];
  /** The continuation token of the next page, or null on the last one. */
  nextToken: string | null;
}

/** The object operations the hosted features need. */
export interface DeliveryStore {
  putJson(
    key: string,
    value: unknown,
    cacheControl: string,
    /** Write only if the object is still as read; else {@link ObjectChangedError}. */
    condition?: PutCondition,
  ): Promise<{ etag: string | null }>;
  /**
   * Writes an already serialized JSON text as is (a revision's `data.json`,
   * whose escaping the caller chose).
   */
  putText(
    key: string,
    text: string,
    cacheControl: string,
    condition?: PutCondition,
  ): Promise<{ etag: string | null }>;
  /** The object, or null when there is none. */
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /**
   * One page of the "folders" right under `prefix` (a delimiter listing,
   * ascending key order), at most `maxKeys` of them.
   */
  listPage(
    prefix: string,
    options: {
      delimiter: "/";
      maxKeys: number;
      continuationToken?: string | null;
    },
  ): Promise<ListPage>;
}

function isConditionFailed(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e?.name === "PreconditionFailed" ||
    e?.name === "ConditionalRequestConflict" ||
    e?.$metadata?.httpStatusCode === 412
  );
}

/**
 * What makes a conditional PUT Unavailable rather than a lost race: a 429,
 * any 5xx, or no HTTP answer at all (network error, timeout).
 */
function isUnavailable(error: unknown): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })
    ?.$metadata?.httpStatusCode;
  return status === undefined || status === 429 || status >= 500;
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

export function createS3DeliveryStore(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): DeliveryStore {
  const options = {
    endpoint: config.endpoint,
    region: "auto",
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: true,
  };
  const client = new S3Client(options);
  /**
   * Conditional PUTs go through a client with the SDK's own retries off: a
   * retried PUT whose first try landed would get 412 from its own write, and
   * look like a lost race (S2). The protocol's attempts handle races.
   */
  const conditionalClient = new S3Client({ ...options, maxAttempts: 1 });
  const Bucket = config.bucket;
  const put = async (
    key: string,
    body: string,
    cacheControl: string,
    condition: PutCondition | undefined,
  ) => {
    try {
      const res = await (condition ? conditionalClient : client).send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: Buffer.from(body, "utf-8"),
          ContentType: "application/json; charset=utf-8",
          CacheControl: cacheControl,
          ...(condition && "ifMatch" in condition
            ? { IfMatch: condition.ifMatch }
            : {}),
          ...(condition && "ifNoneMatch" in condition
            ? { IfNoneMatch: condition.ifNoneMatch }
            : {}),
        }),
      );
      return { etag: res.ETag ?? null };
    } catch (error) {
      if (condition && isConditionFailed(error)) {
        throw new ObjectChangedError(key);
      }
      if (condition && isUnavailable(error)) {
        throw new DeliveryUnavailableError(key, error);
      }
      throw error;
    }
  };
  return {
    putJson: (key, value, cacheControl, condition) =>
      put(key, JSON.stringify(value), cacheControl, condition),
    putText: (key, text, cacheControl, condition) =>
      put(key, text, cacheControl, condition),
    async get(key) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket, Key: key }),
        );
        const text = (await res.Body?.transformToString("utf-8")) ?? "";
        return { text, etag: res.ETag ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        if (isUnavailable(error))
          throw new DeliveryUnavailableError(key, error);
        throw error;
      }
    },
    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (error) {
        if (isNotFound(error)) return;
        if (isUnavailable(error))
          throw new DeliveryUnavailableError(key, error);
        throw error;
      }
    },
    async listPage(prefix, { delimiter, maxKeys, continuationToken }) {
      let res: ListObjectsV2CommandOutput;
      try {
        res = await client.send(
          new ListObjectsV2Command({
            Bucket,
            Prefix: prefix,
            Delimiter: delimiter,
            MaxKeys: maxKeys,
            ...(continuationToken
              ? { ContinuationToken: continuationToken }
              : {}),
          }),
        );
      } catch (error) {
        if (isUnavailable(error))
          throw new DeliveryUnavailableError(prefix, error);
        throw error;
      }
      return {
        prefixes: (res.CommonPrefixes ?? [])
          .map((p) => p.Prefix)
          .filter((p): p is string => typeof p === "string"),
        nextToken: res.IsTruncated ? (res.NextContinuationToken ?? null) : null,
      };
    },
  };
}

let cached: DeliveryStore | null | undefined;

/** The configured delivery bucket, or null when this Studio has none. */
export function deliveryStore(): DeliveryStore | null {
  if (cached !== undefined) return cached;
  const s = getSettings();
  const endpoint =
    s.deliveryR2Endpoint ??
    (s.deliveryR2AccountId
      ? `https://${s.deliveryR2AccountId}.r2.cloudflarestorage.com`
      : undefined);
  cached =
    endpoint &&
    s.deliveryR2Bucket &&
    s.deliveryR2AccessKeyId &&
    s.deliveryR2SecretAccessKey
      ? createS3DeliveryStore({
          endpoint,
          bucket: s.deliveryR2Bucket,
          accessKeyId: s.deliveryR2AccessKeyId,
          secretAccessKey: s.deliveryR2SecretAccessKey,
        })
      : null;
  return cached;
}

/**
 * A draft's pointer target without scheme or version
 * (`delivery.decocms.com/sites/<site>/drafts/<slug>.json`), the form the SDK's
 * `?__draft=<pointer>@<version>` carries.
 */
export function draftPointerTarget(site: string, slug: string): string {
  const origin = new URL(getSettings().deliveryPublicOrigin ?? DELIVERY_ORIGIN);
  return `${origin.host}/${deliveryKeys.draft(site, slug)}`;
}
