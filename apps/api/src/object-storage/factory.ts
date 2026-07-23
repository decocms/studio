import { getSettings } from "../settings";
import { S3Service } from "./s3-service";

let cached: S3Service | null | undefined;

/**
 * Check if object storage is configured via environment variables.
 */
function isObjectStorageConfigured(): boolean {
  const settings = getSettings();
  return !!(
    settings.s3Endpoint &&
    settings.s3Bucket &&
    settings.s3AccessKeyId &&
    settings.s3SecretAccessKey
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

  const settings = getSettings();
  cached = new S3Service({
    endpoint: settings.s3Endpoint!,
    bucket: settings.s3Bucket!,
    region: settings.s3Region,
    accessKeyId: settings.s3AccessKeyId!,
    secretAccessKey: settings.s3SecretAccessKey!,
    forcePathStyle: settings.s3ForcePathStyle,
  });

  return cached;
}
