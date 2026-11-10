/**
 * The hosted Deco CMS delivery bucket: an R2 bucket served read-only at
 * `https://delivery.decocms.com`, written by Studio through R2's S3 API.
 *
 *   sites/<site>/blocks/<hash>.json              one block body (immutable)
 *   sites/<site>/revisions/<id>/index.json       { revision, sequence, blocks }
 *   sites/<site>/revisions/<id>/meta.json        { previous, draft?, reapplyOf?, author, via, message, publishedAt }
 *   sites/<site>/latest.json                     the live index + previewHosts
 *   sites/<site>/drafts/<slug>/index.json        { names }
 *   sites/<site>/drafts/<slug>/<name>.json       one draft file per block name
 *   sites/<site>/schema.json                     the schema the last `deco schema push` sent
 *
 * Keys are only ever built here, from a validated site slug, block hash,
 * revision id, draft slug or block name, so no caller can address anything
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
import { blockFileName, isBlockFileName } from "@decocms/blocks/protocol";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { getSettings } from "@/settings";
import { isRevisionId } from "./revision-id";

export const DELIVERY_ORIGIN = "https://delivery.decocms.com";

/** 16 random bytes, base64url without padding. */
const DRAFT_SLUG_RE = /^[A-Za-z0-9_-]{22}$/;

/** A block hash: `blockVersion`, 22 base64url characters. */
const BLOCK_HASH_RE = /^[A-Za-z0-9_-]{22}$/;

/**
 * The edge holds latest.json up to 1 h (purged after every write); browsers
 * and servers revalidate on every read, so no unchecked stale pointer is used.
 */
export const CACHE_LATEST = "public, max-age=0, s-maxage=3600, must-revalidate";
export const CACHE_REVISION = "public, max-age=31536000, immutable";
/** A block object never changes: its key is its content's hash. */
export const CACHE_BLOCK = "public, max-age=31536000, immutable";
export const CACHE_DRAFT = "no-cache, max-age=0, must-revalidate";
/**
 * The schema is replaced by every deploy's `deco schema push`; Studio reads
 * it from the bucket with a conditional GET, and any other reader revalidates.
 */
export const CACHE_SCHEMA = "no-cache, max-age=0, must-revalidate";

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

function draftFolder(site: string, slug: string): string {
  if (!DRAFT_SLUG_RE.test(slug)) throw new Error("invalid draft slug");
  return `${siteKey(site)}/drafts/${slug}/`;
}

/**
 * A block's draft file name: `blockFileName(name)`, except that the block
 * named `index` is `%69ndex.json`, so it can't be the draft index.
 * `blockNameFromFile` (one decode) gives the name back either way.
 */
export function draftFileName(name: string): string {
  const file = name === "index" ? "%69ndex.json" : blockFileName(name);
  if (name.length === 0 || !isBlockFileName(file)) {
    throw new Error(`invalid block name: ${JSON.stringify(name)}`);
  }
  return file;
}

export const deliveryKeys = {
  latest: (site: string) => `${siteKey(site)}/latest.json`,
  /** The schema the last `deco schema push` sent: `schema.json`. */
  schema: (site: string) => `${siteKey(site)}/schema.json`,
  /** A block body by its hash (immutable): `blocks/<hash>.json`. */
  block: (site: string, hash: string) => {
    if (!BLOCK_HASH_RE.test(hash)) throw new Error("invalid block hash");
    return `${siteKey(site)}/blocks/${hash}.json`;
  },
  revisions: (site: string) => `${siteKey(site)}/revisions/`,
  /** A revision's index (immutable): `revisions/<id>/index.json`. */
  revisionIndex: (site: string, id: string) =>
    `${revisionFolder(site, id)}index.json`,
  /** A revision's meta (immutable): `revisions/<id>/meta.json`. */
  revisionMeta: (site: string, id: string) =>
    `${revisionFolder(site, id)}meta.json`,
  /** The names a draft holds: `drafts/<slug>/index.json`. */
  draftIndex: (site: string, slug: string) =>
    `${draftFolder(site, slug)}index.json`,
  /** One block's draft file: `drafts/<slug>/<draftFileName(name)>`. */
  draftFile: (site: string, slug: string, name: string) =>
    `${draftFolder(site, slug)}${draftFileName(name)}`,
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

/** A conditional read's answer when the object still has the ETag sent. */
export interface NotModified {
  notModified: true;
}

export interface GetOptions {
  /** Answer {@link NotModified} while the object's ETag is this one. */
  ifNoneMatch?: string | null;
}

/** {@link DeliveryStore.get}, with its conditional form. */
export interface DeliveryGet {
  (key: string): Promise<StoredObject | null>;
  (
    key: string,
    options: GetOptions,
  ): Promise<StoredObject | NotModified | null>;
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
  /** Writes an already serialized JSON text as is (an index, a block body). */
  putText(
    key: string,
    text: string,
    cacheControl: string,
    condition?: PutCondition,
  ): Promise<{ etag: string | null }>;
  /**
   * The object, or null when there is none; with `ifNoneMatch`, `{
   * notModified: true }` while the object still has that ETag.
   */
  get: DeliveryGet;
  delete(key: string): Promise<void>;
  /**
   * One page of the "folders" right under `prefix` (a delimiter listing,
   * ascending key order). `maxKeys` caps folders and plain objects together,
   * as S3 does, so a page can hold fewer than `maxKeys` folders. `startAfter`
   * (a full key) starts the listing past it; a continuation token wins over it.
   */
  listPage(
    prefix: string,
    options: {
      delimiter: "/";
      maxKeys: number;
      continuationToken?: string | null;
      startAfter?: string | null;
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

/**
 * How long one conditional PUT of a draft object (a draft's index or one of
 * its files) may wait for R2's answer before it is given up as Unavailable.
 * R2 answers a draft-sized PUT in well under a second (p99 a few hundred
 * ms); the largest draft body is one block of a save request capped at
 * 8 MiB, which needs ~13 s at a poor 5 Mbit/s uplink, so 15 s never cuts
 * off a healthy draft write. A stalled PUT (one sat ~25 s before landing)
 * then fails fast, as a `DeliveryUnavailableError`, the Unavailable answer
 * the editor already retries, instead of holding the save open.
 *
 * Only draft keys get it. A publish writes bodies up to 16 MiB (block
 * objects, a revision's index, `latest.json`), which a poor link can take
 * longer than 15 s to send, and a publish that gave up on a `latest.json`
 * PUT that then landed would leave the site live but unpurged; those PUTs
 * keep the SDK's defaults (no timeout), as before, and are only logged.
 */
export const CONDITIONAL_PUT_TIMEOUT_MS = 15_000;

/** A conditional PUT this slow is logged even when it lands. */
const SLOW_PUT_MS = 2_000;

const DRAFT_KEY_RE = /\/drafts\/[A-Za-z0-9_-]{22}\//;

/** A delivery key fit for logs: a draft's slug is its read grant, so it's hidden. */
function loggableKey(key: string): string {
  return key.replace(DRAFT_KEY_RE, "/drafts/<slug>/");
}

function isNotModified(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NotModified" || e?.$metadata?.httpStatusCode === 304;
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
  /** {@link CONDITIONAL_PUT_TIMEOUT_MS} unless set (tests); draft keys only. */
  conditionalTimeoutMs?: number;
  /** {@link SLOW_PUT_MS} unless set (tests). */
  slowMs?: number;
  /** Where a slow or failed conditional PUT is reported (`console.warn`). */
  warn?: (message: string, fields: Record<string, unknown>) => void;
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
  const timeoutMs = config.conditionalTimeoutMs ?? CONDITIONAL_PUT_TIMEOUT_MS;
  const slowMs = config.slowMs ?? SLOW_PUT_MS;
  const warn = config.warn ?? console.warn;
  const Bucket = config.bucket;
  const put = async (
    key: string,
    body: string,
    cacheControl: string,
    condition: PutCondition | undefined,
  ) => {
    const bytes = Buffer.from(body, "utf-8");
    const command = new PutObjectCommand({
      Bucket,
      Key: key,
      Body: bytes,
      ContentType: "application/json; charset=utf-8",
      CacheControl: cacheControl,
      ...(condition && "ifMatch" in condition
        ? { IfMatch: condition.ifMatch }
        : {}),
      ...(condition && "ifNoneMatch" in condition
        ? { IfNoneMatch: condition.ifNoneMatch }
        : {}),
    });
    if (!condition) {
      const res = await client.send(command);
      return { etag: res.ETag ?? null };
    }
    const started = performance.now();
    // Only a draft write is cut off ({@link CONDITIONAL_PUT_TIMEOUT_MS}).
    const timed = DRAFT_KEY_RE.test(key);
    const signal = timed ? AbortSignal.timeout(timeoutMs) : undefined;
    let outcome = "ok";
    try {
      const res = await conditionalClient.send(
        command,
        signal ? { abortSignal: signal } : {},
      );
      return { etag: res.ETag ?? null };
    } catch (error) {
      if (isConditionFailed(error)) {
        outcome = "changed";
        throw new ObjectChangedError(key);
      }
      if (signal?.aborted) {
        // A PUT given up on may still land: like any Unavailable answer,
        // it is neither a lost race nor a success (contract §2.6).
        outcome = "timeout";
        throw new DeliveryUnavailableError(
          key,
          new Error(`no answer within ${timeoutMs} ms`),
        );
      }
      if (isUnavailable(error)) {
        outcome = "unavailable";
        throw new DeliveryUnavailableError(key, error);
      }
      outcome = "error";
      throw error;
    } finally {
      const durationMs = Math.round(performance.now() - started);
      if (
        outcome === "timeout" ||
        outcome === "unavailable" ||
        durationMs >= slowMs
      ) {
        warn("hosted delivery: slow or failed conditional write", {
          key: loggableKey(key),
          outcome,
          durationMs,
          bytes: bytes.byteLength,
          timeoutMs: timed ? timeoutMs : null,
        });
      }
    }
  };
  function get(key: string): Promise<StoredObject | null>;
  function get(
    key: string,
    options: GetOptions,
  ): Promise<StoredObject | NotModified | null>;
  async function get(
    key: string,
    options?: GetOptions,
  ): Promise<StoredObject | NotModified | null> {
    try {
      const res = await client.send(
        new GetObjectCommand({
          Bucket,
          Key: key,
          ...(options?.ifNoneMatch ? { IfNoneMatch: options.ifNoneMatch } : {}),
        }),
      );
      const text = (await res.Body?.transformToString("utf-8")) ?? "";
      return { text, etag: res.ETag ?? null };
    } catch (error) {
      if (options?.ifNoneMatch && isNotModified(error)) {
        return { notModified: true };
      }
      if (isNotFound(error)) return null;
      if (isUnavailable(error)) throw new DeliveryUnavailableError(key, error);
      throw error;
    }
  }
  return {
    putJson: (key, value, cacheControl, condition) =>
      put(key, JSON.stringify(value), cacheControl, condition),
    putText: (key, text, cacheControl, condition) =>
      put(key, text, cacheControl, condition),
    get,
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
    async listPage(
      prefix,
      { delimiter, maxKeys, continuationToken, startAfter },
    ) {
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
              : startAfter
                ? { StartAfter: startAfter }
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
 * (`delivery.decocms.com/sites/<site>/drafts/<slug>/index.json`), the form
 * the SDK's `?__draft=<pointer>@<version>` carries.
 */
export function draftPointerTarget(site: string, slug: string): string {
  const origin = new URL(getSettings().deliveryPublicOrigin ?? DELIVERY_ORIGIN);
  return `${origin.host}/${deliveryKeys.draftIndex(site, slug)}`;
}
