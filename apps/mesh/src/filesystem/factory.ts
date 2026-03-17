/**
 * Filesystem S3 Service Factory
 *
 * Creates and caches a singleton S3Service instance from environment variables.
 * For v1, only mesh-level S3 config via env vars is supported.
 */

import { S3Service } from "./s3-service";

let cachedService: S3Service | null = null;
let initialized = false;

/**
 * Get the mesh-level filesystem S3 service.
 * Returns null if S3 is not configured (S3_* env vars not set).
 *
 * The service is created once and cached for the lifetime of the process.
 */
export function getFilesystemS3Service(): S3Service | null {
  if (initialized) {
    return cachedService;
  }

  initialized = true;

  const endpoint = process.env.S3_ENDPOINT;
  const bucket = process.env.S3_BUCKET;
  const region = process.env.S3_REGION ?? "auto";
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  cachedService = new S3Service({
    endpoint,
    bucket,
    region,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
  });

  return cachedService;
}

/**
 * Check if filesystem is configured (S3 env vars are set).
 */
export function isFilesystemConfigured(): boolean {
  return !!(
    process.env.S3_ENDPOINT &&
    process.env.S3_BUCKET &&
    process.env.S3_ACCESS_KEY_ID &&
    process.env.S3_SECRET_ACCESS_KEY
  );
}
