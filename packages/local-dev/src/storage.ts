/**
 * Local File Storage Implementation
 *
 * Portable filesystem operations that work with any mounted path.
 */

import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  stat,
  readdir,
  rename,
  copyFile,
  rm,
  open,
} from "node:fs/promises";
import { dirname, basename, extname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { logOp } from "./logger.ts";

/**
 * File entity returned by listing/metadata operations
 */
export interface FileEntity {
  id: string;
  title: string;
  path: string;
  parent: string;
  mimeType: string;
  size: number;
  isDirectory: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * MIME type lookup based on file extension
 */
const MIME_TYPES: Record<string, string> = {
  // Text
  ".txt": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".csv": "text/csv",
  // JavaScript/TypeScript
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".jsx": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  // Data formats
  ".json": "application/json",
  ".xml": "application/xml",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/toml",
  // Markdown
  ".md": "text/markdown",
  ".mdx": "text/mdx",
  ".markdown": "text/markdown",
  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  // Documents
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  // Archives
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  // Audio
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  // Video
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
};

function getMimeType(filename: string): string {
  const ext = extname(filename).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}

/**
 * Reverse MIME type lookup - get extension from MIME type
 */
const MIME_TO_EXT: Record<string, string> = Object.entries(MIME_TYPES).reduce(
  (acc, [ext, mime]) => {
    // Don't overwrite if already set (prefer shorter extensions)
    if (!acc[mime] || ext.length < acc[mime].length) {
      acc[mime] = ext;
    }
    return acc;
  },
  {} as Record<string, string>,
);

// Add common MIME types that might not have extensions in our map
Object.assign(MIME_TO_EXT, {
  "application/octet-stream": ".bin",
  "text/plain": ".txt",
  "application/x-ndjson": ".ndjson",
  "application/jsonl": ".jsonl",
  "application/x-jsonlines": ".jsonl",
});

export function getExtensionFromMimeType(mimeType: string): string {
  // Handle charset suffix (e.g., "application/json; charset=utf-8")
  const baseMime = mimeType.split(";")[0].trim().toLowerCase();
  return MIME_TO_EXT[baseMime] || "";
}

function sanitizePath(path: string): string {
  // Normalize backslashes to forward slashes (Windows compatibility)
  return path
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== ".." && segment !== ".")
    .join("/")
    .replace(/^\/+/, "");
}

/**
 * Local File Storage class
 */
export class LocalFileStorage {
  private rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  get root(): string {
    return this.rootDir;
  }

  /**
   * Normalize a path by stripping the root directory prefix if present.
   * This handles cases where AI agents mistakenly include the full root path.
   */
  normalizePath(path: string): string {
    let normalizedPath = path;

    // Strip root directory prefix if the path starts with it
    // Must check for trailing slash, colon, or exact match to avoid matching paths like
    // /tmp/rootEvil when root is /tmp/root
    const rootWithSlash = this.rootDir + "/";
    const rootWithColon = this.rootDir + ":";
    if (normalizedPath.startsWith(rootWithSlash)) {
      normalizedPath = normalizedPath.slice(rootWithSlash.length);
    } else if (normalizedPath.startsWith(rootWithColon)) {
      // Handle colon separator (e.g., "/path/to/root:filename.png")
      normalizedPath = normalizedPath.slice(rootWithColon.length);
    } else if (normalizedPath === this.rootDir) {
      // Exact match - return root
      normalizedPath = "";
    }

    // Handle standalone colon at start (edge case)
    if (normalizedPath.startsWith(":")) {
      normalizedPath = normalizedPath.slice(1);
    }

    // Strip leading slashes
    normalizedPath = normalizedPath.replace(/^\/+/, "");

    return normalizedPath;
  }

  /**
   * Resolve a relative path to an absolute path within the storage root.
   * Public for use by tools that need the absolute path (e.g., GET_PRESIGNED_URL).
   */
  resolvePath(path: string): string {
    const normalizedPath = this.normalizePath(path);
    const sanitized = sanitizePath(normalizedPath);
    const resolved = resolve(this.rootDir, sanitized);

    // Defense-in-depth: verify resolved path is within rootDir
    if (!resolved.startsWith(this.rootDir)) {
      throw new Error("Path traversal attempt detected");
    }

    return resolved;
  }

  private async ensureDir(dir: string): Promise<void> {
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
  }

  async getMetadata(path: string): Promise<FileEntity> {
    const fullPath = this.resolvePath(path);
    const stats = await stat(fullPath);
    const name = basename(path) || path;
    const parentPath = dirname(path);
    const parent = parentPath === "." || parentPath === "/" ? "" : parentPath;
    const isDirectory = stats.isDirectory();
    const mimeType = isDirectory ? "inode/directory" : getMimeType(name);

    return {
      id: path || "/",
      title: parent ? path : name || "Root",
      path: path || "/",
      parent,
      mimeType,
      size: stats.size,
      isDirectory,
      created_at: stats.birthtime.toISOString(),
      updated_at: stats.mtime.toISOString(),
    };
  }

  async read(
    path: string,
    encoding: "utf-8" | "base64" = "utf-8",
  ): Promise<{ content: string; metadata: FileEntity }> {
    const fullPath = this.resolvePath(path);
    const buffer = await readFile(fullPath);
    const content =
      encoding === "base64"
        ? buffer.toString("base64")
        : buffer.toString("utf-8");
    const metadata = await this.getMetadata(path);
    logOp("READ", path, { size: buffer.length });
    return { content, metadata };
  }

  async write(
    path: string,
    content: string,
    options: {
      encoding?: "utf-8" | "base64";
      createParents?: boolean;
      overwrite?: boolean;
    } = {},
  ): Promise<{ file: FileEntity }> {
    const fullPath = this.resolvePath(path);

    if (options.createParents !== false) {
      await this.ensureDir(dirname(fullPath));
    }

    if (options.overwrite === false && existsSync(fullPath)) {
      throw new Error(`File already exists: ${path}`);
    }

    const buffer =
      options.encoding === "base64"
        ? Buffer.from(content, "base64")
        : Buffer.from(content, "utf-8");

    await writeFile(fullPath, buffer);
    const file = await this.getMetadata(path);
    logOp("WRITE", path, { size: buffer.length });
    return { file };
  }

  async delete(
    path: string,
    recursive = false,
  ): Promise<{ success: boolean; path: string }> {
    const fullPath = this.resolvePath(path);
    const stats = await stat(fullPath);

    if (stats.isDirectory()) {
      if (!recursive) {
        throw new Error("Cannot delete directory without recursive flag");
      }
      await rm(fullPath, { recursive: true, force: true });
    } else {
      await unlink(fullPath);
    }

    logOp("DELETE", path);
    return { success: true, path };
  }

  async list(
    folder = "",
    options: { recursive?: boolean; filesOnly?: boolean } = {},
  ): Promise<FileEntity[]> {
    const fullPath = this.resolvePath(folder);

    if (!existsSync(fullPath)) {
      return [];
    }

    if (options.recursive) {
      const files = await this.listRecursive(folder, options.filesOnly);
      logOp("LIST", folder || "/", { count: files.length, recursive: true });
      return files;
    }

    const entries = await readdir(fullPath, { withFileTypes: true });
    let files: FileEntity[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      // Skip directories if filesOnly is true
      if (options.filesOnly && entry.isDirectory()) continue;

      const entryPath = folder ? `${folder}/${entry.name}` : entry.name;
      try {
        const metadata = await this.getMetadata(entryPath);
        files.push(metadata);
      } catch {
        continue;
      }
    }

    // Sort: directories first, then by name (only relevant if not filesOnly)
    files = files.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.title.localeCompare(b.title);
    });

    logOp("LIST", folder || "/", { count: files.length });
    return files;
  }

  private async listRecursive(
    folder = "",
    filesOnly = false,
  ): Promise<FileEntity[]> {
    const fullPath = this.resolvePath(folder);

    if (!existsSync(fullPath)) {
      return [];
    }

    const entries = await readdir(fullPath, { withFileTypes: true });
    const files: FileEntity[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;

      const entryPath = folder ? `${folder}/${entry.name}` : entry.name;

      try {
        const metadata = await this.getMetadata(entryPath);

        if (entry.isDirectory()) {
          if (!filesOnly) {
            files.push(metadata);
          }
          const subFiles = await this.listRecursive(entryPath, filesOnly);
          files.push(...subFiles);
        } else {
          files.push(metadata);
        }
      } catch {
        continue;
      }
    }

    return files;
  }

  async mkdir(path: string, recursive = true): Promise<{ folder: FileEntity }> {
    const fullPath = this.resolvePath(path);
    await mkdir(fullPath, { recursive });
    const metadata = await this.getMetadata(path);
    logOp("MKDIR", path);
    return { folder: metadata };
  }

  async move(
    from: string,
    to: string,
    overwrite = false,
  ): Promise<{ file: FileEntity }> {
    const fromPath = this.resolvePath(from);
    const toPath = this.resolvePath(to);

    if (!overwrite && existsSync(toPath)) {
      throw new Error(`Destination already exists: ${to}`);
    }

    await this.ensureDir(dirname(toPath));
    await rename(fromPath, toPath);
    const file = await this.getMetadata(to);
    logOp("MOVE", from, { to });
    return { file };
  }

  async copy(
    from: string,
    to: string,
    overwrite = false,
  ): Promise<{ file: FileEntity }> {
    const fromPath = this.resolvePath(from);
    const toPath = this.resolvePath(to);

    if (!overwrite && existsSync(toPath)) {
      throw new Error(`Destination already exists: ${to}`);
    }

    await this.ensureDir(dirname(toPath));
    await copyFile(fromPath, toPath);
    const file = await this.getMetadata(to);
    logOp("COPY", from, { to });
    return { file };
  }

  /**
   * Write a readable stream directly to disk without buffering in memory.
   * Used for streaming large downloads directly to filesystem.
   */
  async writeStream(
    path: string,
    stream: ReadableStream<Uint8Array> | NodeJS.ReadableStream,
    options: {
      createParents?: boolean;
      overwrite?: boolean;
    } = {},
  ): Promise<{ file: FileEntity; bytesWritten: number }> {
    const fullPath = this.resolvePath(path);

    if (options.createParents !== false) {
      await this.ensureDir(dirname(fullPath));
    }

    if (options.overwrite === false && existsSync(fullPath)) {
      throw new Error(`File already exists: ${path}`);
    }

    // Convert Web ReadableStream to Node.js Readable if needed
    const nodeStream =
      stream instanceof Readable
        ? stream
        : Readable.fromWeb(
            stream as unknown as import("stream/web").ReadableStream,
          );

    // Track bytes written
    let bytesWritten = 0;

    // Create write stream
    const fileHandle = await open(fullPath, "w");
    const writeStream = fileHandle.createWriteStream();

    // Create a passthrough that counts bytes
    const countingStream = new Readable({
      read() {},
    });

    nodeStream.on("data", (chunk: Buffer) => {
      bytesWritten += chunk.length;
      countingStream.push(chunk);
    });

    nodeStream.on("end", () => {
      countingStream.push(null);
    });

    nodeStream.on("error", (err) => {
      countingStream.destroy(err);
    });

    await pipeline(countingStream, writeStream);

    const file = await this.getMetadata(path);
    logOp("WRITE_STREAM", path, { size: bytesWritten });
    return { file, bytesWritten };
  }
}
