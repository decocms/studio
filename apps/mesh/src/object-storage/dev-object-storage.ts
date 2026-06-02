/**
 * Dev Object Storage
 *
 * Implements BoundObjectStorage backed by the local filesystem.
 * Intended for development only — injected by context-factory when
 * NODE_ENV=development and no S3 credentials are configured.
 *
 * Files are stored under ./data/assets/<orgId>/.
 * Presigned URLs are HMAC-signed and served by the /api/dev-assets route.
 */

import type { Dirent } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import type {
  GetObjectResult,
  GetObjectTooLargeResult,
  HeadObjectResult,
  ListObjectsResult,
  PutObjectResult,
} from "./s3-service";
import type { BoundObjectStorage } from "./bound-object-storage";
import { detectContentType, isTextContentType, sanitizeKey } from "./key-utils";
import { assertFetchableUrl } from "./fetchable";
import { getSettings } from "../settings";

const DEV_ASSETS_BASE_DIR = "./data/assets";

function orgAssetsDir(orgId: string): string {
  const safe = orgId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(DEV_ASSETS_BASE_DIR, safe);
}

function filePath(orgId: string, key: string): string {
  return join(orgAssetsDir(orgId), sanitizeKey(key));
}

export class DevObjectStorage implements BoundObjectStorage {
  constructor(
    private readonly orgId: string,
    private readonly baseUrl?: string,
  ) {}

  async getBytesOrPresign(
    key: string,
    opts: { presignWhenLargerThan: number; presignExpiresIn?: number },
  ): Promise<GetObjectResult | GetObjectTooLargeResult> {
    const path = filePath(this.orgId, key);
    const info = await stat(path);
    const contentType = detectContentType(key);

    if (info.size > opts.presignWhenLargerThan) {
      return {
        error: "FILE_TOO_LARGE",
        size: info.size,
        maxInlineSize: opts.presignWhenLargerThan,
        presignedUrl: await this.presignedGetUrl(key),
        contentType,
      };
    }

    const bytes = await readFile(path);
    const isText = isTextContentType(contentType);

    return {
      content: isText
        ? new TextDecoder().decode(bytes)
        : Buffer.from(bytes).toString("base64"),
      contentType,
      encoding: isText ? "utf-8" : "base64",
      size: info.size,
      lastModified: info.mtime,
    };
  }

  async getBytes(key: string): Promise<Uint8Array> {
    const bytes = await readFile(filePath(this.orgId, key));
    return new Uint8Array(bytes);
  }

  async put(
    key: string,
    body: string | Uint8Array,
    _options?: { contentType?: string },
  ): Promise<PutObjectResult> {
    const path = filePath(this.orgId, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(
      path,
      typeof body === "string" ? Buffer.from(body, "utf-8") : body,
    );
    return { key };
  }

  async list(options?: {
    prefix?: string;
    maxKeys?: number;
    delimiter?: string;
  }): Promise<ListObjectsResult> {
    const baseDir = options?.prefix
      ? join(orgAssetsDir(this.orgId), sanitizeKey(options.prefix))
      : orgAssetsDir(this.orgId);

    let entries: Dirent[];
    try {
      entries = await readdir(baseDir, { withFileTypes: true });
    } catch {
      return { objects: [], isTruncated: false };
    }

    const max = options?.maxKeys ?? 1000;
    const prefix = options?.prefix;

    // Filter to files only — directories are only relevant as commonPrefixes
    // when a delimiter is set (mirrors S3 behavior).
    const fileEntries = entries.filter((e) => e.isFile());

    if (options?.delimiter) {
      // S3 maxKeys caps the combined count of objects + commonPrefixes.
      const commonPrefixes: string[] = [];
      const dirEntries = entries.filter((e) => e.isDirectory());
      for (const entry of dirEntries) {
        const dirKey = prefix ? `${prefix}/${entry.name}/` : `${entry.name}/`;
        commonPrefixes.push(dirKey);
      }
      commonPrefixes.sort();

      // Cap combined results at maxKeys
      let remaining = max;
      const cappedPrefixes = commonPrefixes.slice(0, remaining);
      remaining -= cappedPrefixes.length;

      const cappedFiles = fileEntries.slice(0, remaining);
      const totalItems = commonPrefixes.length + fileEntries.length;

      const objects = await Promise.all(
        cappedFiles.map(async (entry) => {
          const info = await stat(join(baseDir, entry.name));
          return {
            key: prefix ? `${prefix}/${entry.name}` : entry.name,
            size: info.size,
            lastModified: info.mtime,
          };
        }),
      );

      return {
        objects,
        isTruncated: totalItems > max,
        commonPrefixes: cappedPrefixes.length > 0 ? cappedPrefixes : undefined,
      };
    }

    // No delimiter: flat listing of files only
    const objects = await Promise.all(
      fileEntries.slice(0, max).map(async (entry) => {
        const info = await stat(join(baseDir, entry.name));
        return {
          key: prefix ? `${prefix}/${entry.name}` : entry.name,
          size: info.size,
          lastModified: info.mtime,
        };
      }),
    );

    return { objects, isTruncated: fileEntries.length > max };
  }

  async delete(key: string): Promise<void> {
    await unlink(filePath(this.orgId, key));
  }

  async head(key: string): Promise<HeadObjectResult> {
    const info = await stat(filePath(this.orgId, key));
    return {
      contentType: detectContentType(key),
      size: info.size,
      lastModified: info.mtime,
    };
  }

  /**
   * Returns a data: URL with the file content embedded inline.
   *
   * AI SDK and vision models reject localhost URLs, so we inline the bytes
   * instead of generating an HMAC-signed redirect to /api/dev-assets/.
   * The /api/dev-assets/ route is still used by external clients (e.g. the UI)
   * via the stable redirect endpoint (/api/:org/files/:key).
   */
  async presignedGetUrl(
    key: string,
    _expiresIn?: number,
    opts?: { requireFetchable?: boolean },
  ): Promise<string> {
    const path = filePath(this.orgId, key);
    const bytes = await readFile(path);
    const contentType = detectContentType(key);
    const base64 = Buffer.from(bytes).toString("base64");
    const url = `data:${contentType};base64,${base64}`;
    if (opts?.requireFetchable) {
      assertFetchableUrl(url);
    }
    return url;
  }

  async presignedPutUrl(key: string, expiresIn = 3600): Promise<string> {
    if (!this.baseUrl) {
      throw new Error("baseUrl required for presigned PUT URLs in dev mode");
    }
    const sanitized = sanitizeKey(key);
    const expires = Math.floor(Date.now() / 1000) + expiresIn;
    const secret = getSettings().encryptionKey || "dev-secret";
    const data = `${this.orgId}:${sanitized}:${expires}:PUT`;
    const signature = createHmac("sha256", secret).update(data).digest("hex");

    const url = new URL(
      `/api/dev-assets/${this.orgId}/${sanitized}`,
      this.baseUrl,
    );
    url.searchParams.set("expires", expires.toString());
    url.searchParams.set("signature", signature);
    url.searchParams.set("method", "PUT");
    return url.toString();
  }
}
