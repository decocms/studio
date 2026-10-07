/**
 * The hosted Deco CMS delivery bucket: an R2 bucket served read-only at
 * `https://delivery.decocms.com`, written by Studio through R2's S3 API.
 *
 *   sites/<site>/latest.json             { revision, schemaHash, publishedAt }
 *   sites/<site>/revisions/<sha>.json    { revision, schemaHash, blocks }
 *   sites/<site>/drafts/<slug>.json      { set, delete }
 *
 * Keys are only ever built here, from a validated site slug, commit sha or
 * draft slug, so no caller can address anything outside its site's prefix.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { getSettings } from "@/settings";

const DELIVERY_ORIGIN = "https://delivery.decocms.com";

/** A git commit sha (SHA-1): a revision id. */
const COMMIT_SHA_RE = /^[0-9a-f]{40}$/;
/** 16 random bytes, base64url without padding. */
const DRAFT_SLUG_RE = /^[A-Za-z0-9_-]{22}$/;

export const CACHE_LATEST = "public, max-age=10, must-revalidate";
export const CACHE_REVISION = "public, max-age=31536000, immutable";
export const CACHE_DRAFT = "no-cache, max-age=0, must-revalidate";

export function isCommitSha(value: string): boolean {
  return COMMIT_SHA_RE.test(value);
}

function siteKey(site: string): string {
  if (!isValidSiteSlug(site)) throw new Error(`invalid site id: ${site}`);
  return `sites/${site}`;
}

export const deliveryKeys = {
  latest: (site: string) => `${siteKey(site)}/latest.json`,
  revisions: (site: string) => `${siteKey(site)}/revisions/`,
  revision: (site: string, sha: string) => {
    if (!isCommitSha(sha)) throw new Error(`invalid revision: ${sha}`);
    return `${siteKey(site)}/revisions/${sha}.json`;
  },
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

/** The four object operations the hosted features need. */
export interface DeliveryStore {
  putJson(
    key: string,
    value: unknown,
    cacheControl: string,
  ): Promise<{ etag: string | null }>;
  /** The object, or null when there is none. */
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  /** Every key under `prefix`, paging through the whole listing. */
  listKeys(prefix: string): Promise<string[]>;
}

/** The commit shas that have a revision object for `site`: one paged listing. */
export async function listRevisionShas(
  store: DeliveryStore,
  site: string,
): Promise<Set<string>> {
  const prefix = deliveryKeys.revisions(site);
  const shas = new Set<string>();
  for (const key of await store.listKeys(prefix)) {
    const sha = key.slice(prefix.length).replace(/\.json$/, "");
    if (isCommitSha(sha)) shas.add(sha);
  }
  return shas;
}

export async function getJson(
  store: DeliveryStore,
  key: string,
): Promise<{ value: unknown; etag: string | null } | null> {
  const object = await store.get(key);
  if (!object) return null;
  return { value: JSON.parse(object.text) as unknown, etag: object.etag };
}

function isNotFound(error: unknown): boolean {
  const e = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}

function createS3DeliveryStore(config: {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}): DeliveryStore {
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
  return {
    async putJson(key, value, cacheControl) {
      const res = await client.send(
        new PutObjectCommand({
          Bucket,
          Key: key,
          Body: Buffer.from(JSON.stringify(value), "utf-8"),
          ContentType: "application/json; charset=utf-8",
          CacheControl: cacheControl,
        }),
      );
      return { etag: res.ETag ?? null };
    },
    async get(key) {
      try {
        const res = await client.send(
          new GetObjectCommand({ Bucket, Key: key }),
        );
        const text = (await res.Body?.transformToString("utf-8")) ?? "";
        return { text, etag: res.ETag ?? null };
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async listKeys(prefix) {
      const keys: string[] = [];
      let token: string | undefined;
      do {
        const res = await client.send(
          new ListObjectsV2Command({
            Bucket,
            Prefix: prefix,
            ContinuationToken: token,
          }),
        );
        for (const object of res.Contents ?? []) {
          if (object.Key) keys.push(object.Key);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);
      return keys;
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
