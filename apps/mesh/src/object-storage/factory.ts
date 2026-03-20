import { env } from "../env";
import { S3Service } from "./s3-service";

let cached: S3Service | null | undefined;

/**
 * Check if object storage is configured via environment variables.
 */
function isObjectStorageConfigured(): boolean {
  return !!(
    env.S3_ENDPOINT &&
    env.S3_BUCKET &&
    env.S3_ACCESS_KEY_ID &&
    env.S3_SECRET_ACCESS_KEY
  );
}

/**
 * Get or create the singleton S3Service instance.
 * Returns null if S3 environment variables are not configured.
 */
export function getObjectStorageS3Service(): S3Service | null {
  if (cached !== undefined) return cached;

  if (!isObjectStorageConfigured()) {
    cached = null;
    return null;
  }

  cached = new S3Service({
    endpoint: env.S3_ENDPOINT!,
    bucket: env.S3_BUCKET!,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  });

  return cached;
}
