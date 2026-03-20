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
  get(key: string): Promise<GetObjectResult | GetObjectTooLargeResult>;
  put(
    key: string,
    body: string | Uint8Array,
    options?: { contentType?: string },
  ): Promise<PutObjectResult>;
  list(options?: {
    prefix?: string;
    maxKeys?: number;
    continuationToken?: string;
  }): Promise<ListObjectsResult>;
  delete(key: string): Promise<void>;
  head(key: string): Promise<HeadObjectResult>;
}

/**
 * Create an org-scoped object storage wrapper.
 */
export function createBoundObjectStorage(
  s3: S3Service,
  orgId: string,
): BoundObjectStorage {
  return {
    get: (key) => s3.get(orgId, key),
    put: (key, body, options) => s3.put(orgId, key, body, options),
    list: (options) => s3.list(orgId, options),
    delete: (key) => s3.delete(orgId, key),
    head: (key) => s3.head(orgId, key),
  };
}
