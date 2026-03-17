/**
 * S3 Service
 *
 * Wraps @aws-sdk/client-s3 with org-scoped path isolation.
 * Provides filesystem-like operations (read, write, list, delete, metadata)
 * backed by any S3-compatible storage (AWS S3, Cloudflare R2, MinIO, Backblaze B2).
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  buildS3Key,
  buildS3Prefix,
  detectContentType,
  isTextContentType,
  stripOrgPrefix,
} from "./path-utils";
import type {
  FsDeleteOutput,
  FsListInput,
  FsListOutput,
  FsMetadataOutput,
  FsReadOutput,
  FsWriteOutput,
} from "@decocms/bindings/filesystem";

/** Maximum file size for inline content reads (1 MB) */
const MAX_INLINE_READ_SIZE = 1 * 1024 * 1024;

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export class S3Service {
  private client: S3Client;
  private bucket: string;

  constructor(config: S3Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
    });
  }

  async readFile(
    orgId: string,
    path: string,
    offset?: number,
    limit?: number,
  ): Promise<FsReadOutput> {
    const key = buildS3Key(orgId, path);

    // First, HEAD to get metadata
    const head = await this.client
      .send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      .catch(
        (err: { name?: string; $metadata?: { httpStatusCode?: number } }) => {
          if (
            err.name === "NotFound" ||
            err.$metadata?.httpStatusCode === 404
          ) {
            return null;
          }
          throw err;
        },
      );

    if (!head) {
      return { size: 0, error: "FILE_NOT_FOUND" };
    }

    const size = head.ContentLength ?? 0;
    const contentType = head.ContentType ?? detectContentType(path);

    // Check size limit for full reads (partial reads are always allowed)
    if (!offset && !limit && size > MAX_INLINE_READ_SIZE) {
      return { size, contentType, error: "FILE_TOO_LARGE" };
    }

    // Build range header for partial reads
    let range: string | undefined;
    if (offset !== undefined || limit !== undefined) {
      const start = offset ?? 0;
      const end = limit !== undefined ? start + limit - 1 : "";
      range = `bytes=${start}-${end}`;
    }

    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Range: range,
      }),
    );

    if (!response.Body) {
      return { size, contentType, error: "FILE_NOT_FOUND" };
    }

    const isText = isTextContentType(contentType);

    if (isText) {
      const content = await response.Body.transformToString("utf-8");
      return { content, encoding: "utf-8", contentType, size };
    }

    // Binary content — return as base64
    const bytes = await response.Body.transformToByteArray();
    const content = Buffer.from(bytes).toString("base64");
    return { content, encoding: "base64", contentType, size };
  }

  async writeFile(
    orgId: string,
    path: string,
    content: string,
    encoding: "utf-8" | "base64" = "utf-8",
    contentType?: string,
  ): Promise<FsWriteOutput> {
    const key = buildS3Key(orgId, path);
    const resolvedContentType = contentType ?? detectContentType(path);

    let body: Buffer;
    if (encoding === "base64") {
      body = Buffer.from(content, "base64");
    } else {
      body = Buffer.from(content, "utf-8");
    }

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: resolvedContentType,
      }),
    );

    return { path, size: body.length };
  }

  async listFiles(orgId: string, input: FsListInput): Promise<FsListOutput> {
    const prefix = buildS3Prefix(orgId, input.path);
    const maxKeys = Math.min(input.maxKeys ?? 100, 1000);

    const response = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        Delimiter: "/",
        MaxKeys: maxKeys,
        ContinuationToken: input.continuationToken,
      }),
    );

    const entries: FsListOutput["entries"] = [];

    // Add directories (common prefixes)
    if (response.CommonPrefixes) {
      for (const cp of response.CommonPrefixes) {
        if (cp.Prefix) {
          const dirPath = stripOrgPrefix(orgId, cp.Prefix);
          // Filter by pattern if provided
          if (input.pattern && !matchGlob(dirPath, input.pattern)) {
            continue;
          }
          entries.push({ path: dirPath, type: "directory" });
        }
      }
    }

    // Add files
    if (response.Contents) {
      for (const obj of response.Contents) {
        if (!obj.Key) continue;
        // Skip the prefix itself (S3 can return the directory marker)
        if (obj.Key === prefix) continue;

        const filePath = stripOrgPrefix(orgId, obj.Key);
        // Filter by pattern if provided
        if (input.pattern && !matchGlob(filePath, input.pattern)) {
          continue;
        }
        entries.push({
          path: filePath,
          type: "file",
          size: obj.Size,
          lastModified: obj.LastModified?.toISOString(),
        });
      }
    }

    return {
      entries,
      isTruncated: response.IsTruncated ?? false,
      nextContinuationToken: response.NextContinuationToken,
    };
  }

  async deleteFile(orgId: string, path: string): Promise<FsDeleteOutput> {
    const key = buildS3Key(orgId, path);

    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    // S3 DeleteObject is idempotent (returns 204 even for nonexistent keys)
    return { success: true, path };
  }

  async getMetadata(orgId: string, path: string): Promise<FsMetadataOutput> {
    const key = buildS3Key(orgId, path);

    const head = await this.client.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );

    return {
      size: head.ContentLength ?? 0,
      contentType: head.ContentType ?? detectContentType(path),
      lastModified:
        head.LastModified?.toISOString() ?? new Date().toISOString(),
      etag: head.ETag ?? "",
    };
  }

  destroy(): void {
    this.client.destroy();
  }
}

/**
 * Simple glob pattern matching for filtering file paths.
 * Supports * (any chars except /) and ** (any chars including /).
 */
function matchGlob(path: string, pattern: string): boolean {
  // Strip trailing slash so directory entries (e.g. "docs/") match by name
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  // Get just the filename for patterns without /
  const target = pattern.includes("/")
    ? normalized
    : (normalized.split("/").pop() ?? normalized);

  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\?/g, "[^/]");

  return new RegExp(`^${regexStr}$`).test(target);
}
