/**
 * Context Repo File Indexer
 *
 * Indexes repository files for fast search. Stores index as JSON on disk
 * alongside the cloned repo (NOT in the database).
 */

import { join } from "node:path";
import { stat, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { listAllFiles } from "./gh-cli";

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".ico",
  ".svg",
  ".webp",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
  ".mp3",
  ".mp4",
  ".wav",
  ".ogg",
  ".webm",
  ".zip",
  ".tar",
  ".gz",
  ".bz2",
  ".7z",
  ".rar",
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".wasm",
  ".pyc",
  ".class",
  ".o",
  ".so",
  ".dylib",
  ".map",
]);

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  "__pycache__",
  ".next",
  ".nuxt",
  ".output",
  "coverage",
  ".cache",
  ".turbo",
  ".vercel",
]);

const MAX_FILE_SIZE = 100 * 1024;
const MAX_FILES = 10_000;
const SNIPPET_LENGTH = 500;

export interface IndexedFile {
  path: string;
  size: number;
  hash: string;
  snippets: string[];
}

export interface RepoIndex {
  version: 1;
  indexedAt: string;
  fileCount: number;
  totalSizeBytes: number;
  files: IndexedFile[];
}

function shouldSkipFile(filePath: string): boolean {
  const parts = filePath.split("/");
  for (const part of parts) {
    if (SKIP_DIRS.has(part)) return true;
  }
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot >= 0) {
    const ext = filePath.substring(lastDot).toLowerCase();
    if (BINARY_EXTENSIONS.has(ext)) return true;
  }
  if (filePath.endsWith(".min.js") || filePath.endsWith(".min.css"))
    return true;
  return false;
}

export async function buildIndex(
  repoPath: string,
  folderFilter?: string[] | null,
): Promise<RepoIndex> {
  const allFiles = await listAllFiles(repoPath);
  const files: IndexedFile[] = [];
  let totalSize = 0;

  for (const filePath of allFiles) {
    if (files.length >= MAX_FILES) break;
    if (shouldSkipFile(filePath)) continue;
    // If folder filter is set, only index files in selected folders
    if (folderFilter && folderFilter.length > 0) {
      const isRootFile = !filePath.includes("/");
      if (isRootFile) {
        // Root files only included if "<root>" is in the filter
        if (!folderFilter.includes("<root>")) continue;
      } else {
        const topDir = filePath.split("/")[0];
        if (topDir && !folderFilter.includes(topDir)) continue;
      }
    }

    const fullPath = join(repoPath, filePath);
    try {
      const fileStat = await stat(fullPath);
      if (!fileStat.isFile() || fileStat.size > MAX_FILE_SIZE) continue;

      const content = await readFile(fullPath, "utf-8");
      const hash = createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 16);
      const snippets = [content.slice(0, SNIPPET_LENGTH)];

      files.push({ path: filePath, size: fileStat.size, hash, snippets });
      totalSize += fileStat.size;
    } catch {
      // Skip files we can't read
    }
  }

  return {
    version: 1,
    indexedAt: new Date().toISOString(),
    fileCount: files.length,
    totalSizeBytes: totalSize,
    files,
  };
}

export async function saveIndex(
  repoPath: string,
  index: RepoIndex,
): Promise<void> {
  await writeFile(
    join(repoPath, ".deco-index.json"),
    JSON.stringify(index),
    "utf-8",
  );
}

export async function loadIndex(repoPath: string): Promise<RepoIndex | null> {
  try {
    const content = await readFile(join(repoPath, ".deco-index.json"), "utf-8");
    return JSON.parse(content) as RepoIndex;
  } catch {
    return null;
  }
}

export interface SearchResult {
  path: string;
  snippet: string;
  rank: number;
}

export function searchIndex(
  index: RepoIndex,
  query: string,
  limit = 20,
): SearchResult[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const results: SearchResult[] = [];

  for (const file of index.files) {
    const pathLower = file.path.toLowerCase();
    const allText = [
      pathLower,
      ...file.snippets.map((s) => s.toLowerCase()),
    ].join("\n");

    let matchCount = 0;
    for (const term of terms) {
      if (allText.includes(term)) matchCount++;
    }

    if (matchCount > 0) {
      const bestSnippet =
        file.snippets.find((s) =>
          terms.some((t) => s.toLowerCase().includes(t)),
        ) ||
        file.snippets[0] ||
        "";

      const idx = bestSnippet.toLowerCase().indexOf(terms[0]!);
      const start = Math.max(0, idx - 100);
      const end = Math.min(bestSnippet.length, idx + 200);
      const snippet =
        (start > 0 ? "..." : "") +
        bestSnippet.slice(start, end) +
        (end < bestSnippet.length ? "..." : "");

      results.push({
        path: file.path,
        snippet: snippet.trim(),
        rank:
          matchCount / terms.length + (pathLower.includes(terms[0]!) ? 0.5 : 0),
      });
    }
  }

  results.sort((a, b) => b.rank - a.rank);
  return results.slice(0, limit);
}
