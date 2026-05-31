import type {
  GetObjectResult,
  GetObjectTooLargeResult,
  HeadObjectResult,
  ListObjectsResult,
  PutObjectResult,
  S3Service,
} from "./s3-service";

/**
 * Org-scoped wrapper around S3Service.
 * Bakes in the org ID so callers don't need to pass it on every call.
 */
export interface BoundObjectStorage {
  /**
   * Read an object for inlining, capped at a caller-supplied size threshold.
   * Objects larger than `presignWhenLargerThan` come back as a
   * `FILE_TOO_LARGE` marker with a presigned URL instead of inline content.
   * The threshold is the caller's policy (NATS payload / model-context
   * budget) — pass it explicitly.
   */
  getBytesOrPresign(
    key: string,
    opts: { presignWhenLargerThan: number; presignExpiresIn?: number },
  ): Promise<GetObjectResult | GetObjectTooLargeResult>;
  /**
   * Read an object's raw bytes regardless of size. Unlike `getBytesOrPresign`,
   * this is not capped — use it for server-side consumers that need the full
   * content and don't relay it through NATS.
   */
  getBytes(key: string): Promise<Uint8Array>;
  put(
    key: string,
    body: string | Uint8Array,
    options?: { contentType?: string },
  ): Promise<PutObjectResult>;
  list(options?: {
    prefix?: string;
    maxKeys?: number;
    continuationToken?: string;
    delimiter?: string;
  }): Promise<ListObjectsResult>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<HeadObjectResult>;
  /** Generate a presigned GET URL for the given key. */
  presignedGetUrl(key: string, expiresIn?: number): Promise<string>;
  /** Generate a presigned PUT URL for the given key. */
  presignedPutUrl(
    key: string,
    expiresIn?: number,
    contentType?: string,
  ): Promise<string>;
}

/**
 * Create an org-scoped object storage wrapper.
 */
export function createBoundObjectStorage(
  s3: S3Service,
  orgId: string,
): BoundObjectStorage {
  return {
    getBytesOrPresign: (key, opts) => s3.getBytesOrPresign(orgId, key, opts),
    getBytes: (key) => s3.getBytes(orgId, key),
    put: (key, body, options) => s3.put(orgId, key, body, options),
    list: (options) => s3.list(orgId, options),
    delete: (key) => s3.delete(orgId, key),
    head: (key) => s3.head(orgId, key),
    presignedGetUrl: (key, expiresIn) =>
      s3.presignedGetUrl(orgId, key, expiresIn),
    presignedPutUrl: (key, expiresIn, contentType) =>
      s3.presignedPutUrl(orgId, key, expiresIn, contentType),
  };
}
