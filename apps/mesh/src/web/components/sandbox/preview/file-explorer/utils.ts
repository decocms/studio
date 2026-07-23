import { Brackets, File02, FileCode01, Image01 } from "@untitledui/icons";
import type { FlatNode, TreeNode } from "./types";
import { decoBlockKeyFromFileStem } from "@/web/components/sections-editor/deco-block-key";

/** File explorer glob cap (agent default stays 1000 on the daemon). */
export const EXPLORER_GLOB_LIMIT = 10_000;
/** Eager-load directory depth; deeper paths load on expand. */
export const EXPLORER_EAGER_DEPTH = 3;

export type GlobListResult = {
  files: string[];
  directories: string[];
  truncated?: boolean;
};

function normalizePath(path: string) {
  if (!path.trim()) {
    return "/";
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.replace(/\/+/g, "/");
}

/** The daemon expects relative paths (no leading slash). */
export function toDaemonPath(treePath: string) {
  return treePath.startsWith("/") ? treePath.slice(1) : treePath;
}

/**
 * Guards the deep-link `openPath` (sourced from the `?main=code:<path>` URL
 * param) before it's used to read a file from the sandbox: rejects `..`
 * traversal, backslashes, remote-looking URLs, and paths that stay absolute
 * even after the single-leading-slash strip in `toDaemonPath`, so a crafted
 * link can't make the daemon resolve outside the workspace root.
 */
export function isSafeExplorerOpenPath(path: string): boolean {
  const normalized = toDaemonPath(path);
  if (!normalized || normalized.includes("..") || normalized.includes("\\")) {
    return false;
  }
  return (
    normalized.startsWith(".deco/blocks/") ||
    (!normalized.startsWith("/") && !normalized.includes("://"))
  );
}

/** Path as shown in the explorer tree (leading slash). */
export function toTreePath(daemonPath: string) {
  if (!daemonPath.trim()) return "/";
  return daemonPath.startsWith("/") ? daemonPath : `/${daemonPath}`;
}

export function getParentTreePath(treePath: string): string {
  const normalized = toTreePath(treePath);
  if (normalized === "/") return "/";
  const parts = normalized.split("/").filter(Boolean);
  parts.pop();
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

export function joinTreePath(parent: string, name: string): string {
  const trimmedName = name.replace(/^\/+|\/+$/g, "");
  if (!trimmedName) return toTreePath(parent);
  const base = parent === "/" ? "" : parent;
  return toTreePath(`${base}/${trimmedName}`);
}

export function getDirectoryContextPath(
  treePath: string,
  kind: TreeNode["kind"],
): string {
  return kind === "directory" ? treePath : getParentTreePath(treePath);
}

/** Single-segment name validation for create/rename in the file explorer. */
export function validateExplorerEntryName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "Name is required";
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("\0")
  ) {
    return "Name cannot contain /, \\, or ..";
  }
  return null;
}

export function getPathDepth(treePath: string): number {
  const daemonPath = toDaemonPath(treePath);
  if (!daemonPath) return 0;
  return daemonPath.split("/").filter(Boolean).length;
}

export function mergeGlobLists(
  prevFiles: readonly string[],
  prevDirs: readonly string[],
  next: GlobListResult,
  prevTruncated = false,
): GlobListResult {
  return {
    files: [...new Set([...prevFiles, ...next.files])],
    directories: [...new Set([...prevDirs, ...(next.directories ?? [])])],
    truncated: prevTruncated || Boolean(next.truncated),
  };
}

export function directoryNeedsLazyLoad(
  treePath: string,
  loadedLazyDirs: ReadonlySet<string>,
): boolean {
  return (
    getPathDepth(treePath) >= EXPLORER_EAGER_DEPTH &&
    !loadedLazyDirs.has(treePath)
  );
}

/** Whether `treePath` already exists in the glob file list (file or directory). */
export function pathExistsInFileList(
  treePath: string,
  fileList: readonly string[],
  directoryList: readonly string[] = [],
): boolean {
  const daemonPath = toDaemonPath(treePath);
  if (fileList.includes(daemonPath)) return true;
  if (directoryList.includes(daemonPath)) return true;
  if (!daemonPath) return false;
  const prefix = `${daemonPath}/`;
  return (
    fileList.some((file) => file.startsWith(prefix)) ||
    directoryList.some((dir) => dir.startsWith(prefix))
  );
}

/** Extract decofile block key from `.deco/blocks/<key>.json`, if applicable. */
export function decoBlockKeyFromTreePath(treePath: string): string | null {
  const daemonPath = toDaemonPath(treePath);
  const prefix = ".deco/blocks/";
  if (!daemonPath.startsWith(prefix) || !daemonPath.endsWith(".json")) {
    return null;
  }
  const stem = daemonPath.slice(prefix.length, -".json".length);
  return decoBlockKeyFromFileStem(stem);
}

export function getLanguageFromPath(filepath: string | null) {
  if (!filepath) return "plaintext";

  const n = filepath.toLowerCase();

  if (n.endsWith(".tsx") || n.endsWith(".ts")) return "typescript";
  if (
    n.endsWith(".jsx") ||
    n.endsWith(".js") ||
    n.endsWith(".mjs") ||
    n.endsWith(".cjs")
  )
    return "javascript";
  if (n.endsWith(".json")) return "json";
  if (n.endsWith(".md") || n.endsWith(".mdx")) return "markdown";
  if (n.endsWith(".css")) return "css";
  if (n.endsWith(".scss")) return "scss";
  if (n.endsWith(".html")) return "html";
  if (n.endsWith(".yaml") || n.endsWith(".yml")) return "yaml";
  if (n.endsWith(".xml") || n.endsWith(".svg")) return "xml";
  if (n.endsWith(".py")) return "python";
  if (n.endsWith(".sql")) return "sql";
  if (n.endsWith(".sh")) return "shell";

  return "plaintext";
}

export type FileIcon = React.ComponentType<{
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}>;

/** Warm folder tone — reads well on both light and dark backgrounds. */
const DEFAULT_FILE_COLOR = "#94a3b8";

/**
 * Maps a filename to an icon + accent color by extension, so the tree reads at
 * a glance (blue for TS, amber for JSON, purple for images, …). Colors are
 * inline (not Tailwind scale tokens) and chosen to work in light and dark.
 */
export function getFileVisual(name: string): { Icon: FileIcon; color: string } {
  const n = name.toLowerCase();
  if (n.endsWith(".tsx") || n.endsWith(".ts"))
    return { Icon: FileCode01, color: "#3b82f6" };
  if (
    n.endsWith(".jsx") ||
    n.endsWith(".js") ||
    n.endsWith(".mjs") ||
    n.endsWith(".cjs")
  )
    return { Icon: FileCode01, color: "#d9a441" };
  if (n.endsWith(".json")) return { Icon: Brackets, color: "#cb9b3f" };
  if (n.endsWith(".css") || n.endsWith(".scss"))
    return { Icon: FileCode01, color: "#06b6d4" };
  if (n.endsWith(".html") || n.endsWith(".xml"))
    return { Icon: FileCode01, color: "#f97316" };
  if (/\.(png|jpe?g|gif|webp|avif|ico|svg)$/.test(n))
    return { Icon: Image01, color: "#a855f7" };
  if (n.endsWith(".md") || n.endsWith(".mdx"))
    return { Icon: File02, color: "#64748b" };
  return { Icon: File02, color: DEFAULT_FILE_COLOR };
}

export function getAncestorDirectories(filepath: string) {
  const parts = normalizePath(filepath).split("/").filter(Boolean);
  const directories = ["/"];
  let current = "";

  for (const part of parts.slice(0, -1)) {
    current += `/${part}`;
    directories.push(current);
  }

  return directories;
}

export function buildFileTree(
  files: string[],
  directories: readonly string[] = [],
): TreeNode[] {
  const root: TreeNode = {
    name: "/",
    path: "/",
    kind: "directory",
    children: [],
  };

  // Name -> child lookup per directory, keyed by the directory's path. Avoids
  // an O(children) linear scan per inserted entry (O(n^2) for a directory with
  // many siblings, e.g. up to EXPLORER_GLOB_LIMIT files in one folder).
  const childByName = new Map<string, Map<string, TreeNode>>();
  const getChildMap = (node: TreeNode) => {
    let map = childByName.get(node.path);
    if (!map) {
      map = new Map();
      childByName.set(node.path, map);
    }
    return map;
  };

  const ensureDirectory = (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    const parts = normalized.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    for (const part of parts) {
      currentPath += `/${part}`;
      const map = getChildMap(current);
      let child = map.get(part);
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          kind: "directory",
          children: [],
        };
        current.children.push(child);
        map.set(part, child);
      } else if (child.kind === "file") {
        child.kind = "directory";
      }
      current = child;
    }
  };

  for (const rawFile of files) {
    const file = normalizePath(rawFile);
    const parts = file.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    parts.forEach((part, index) => {
      currentPath += `/${part}`;
      const isFile = index === parts.length - 1;
      const map = getChildMap(current);
      let child = map.get(part);

      if (!child) {
        child = {
          name: part,
          path: currentPath,
          kind: isFile ? "file" : "directory",
          children: [],
        };
        current.children.push(child);
        map.set(part, child);
      }

      current = child;
    });
  }

  for (const rawDirectory of directories) {
    ensureDirectory(toTreePath(rawDirectory));
  }

  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const node of nodes) {
      if (node.children.length > 0) sortNodes(node.children);
    }
  };

  sortNodes(root.children);
  return root.children;
}

export function flattenTree(
  nodes: TreeNode[],
  expandedDirectories: Set<string>,
  depth = 0,
): FlatNode[] {
  const rows: FlatNode[] = [];

  for (const node of nodes) {
    if (node.name === ".gitkeep") continue;
    rows.push({ node, depth });

    if (
      node.kind === "directory" &&
      node.children.length > 0 &&
      expandedDirectories.has(node.path)
    ) {
      rows.push(...flattenTree(node.children, expandedDirectories, depth + 1));
    }
  }

  return rows;
}

/** A single content-search hit inside a file. */
export interface GrepContentMatch {
  /** Tree path (leading slash), matching the file-tree node paths. */
  path: string;
  line: number;
  text: string;
}

/** Content-search hits for one file, in the order ripgrep reported them. */
interface GrepFileGroup {
  path: string;
  matches: GrepContentMatch[];
}

/**
 * Parse the daemon grep route's `output_mode: "content"` output — newline-
 * separated `file:line:text` rows (ripgrep `--line-number`, repo-relative
 * paths) — into structured hits. Rows that don't match the shape (e.g. ripgrep
 * context separators) are skipped.
 *
 * `packages/sandbox/server/provider/sandbox-fs-hooks.ts` has an equivalent
 * `parseGrepResults` for the LLM-facing grep tool — same wire shape, kept
 * separate because packages can't import app code. Update both if the shape
 * changes.
 */
export function parseGrepContent(results: string): GrepContentMatch[] {
  const matches: GrepContentMatch[] = [];
  for (const row of results.split("\n")) {
    if (!row) continue;
    const firstColon = row.indexOf(":");
    if (firstColon < 0) continue;
    const secondColon = row.indexOf(":", firstColon + 1);
    if (secondColon < 0) continue;
    const line = Number.parseInt(row.slice(firstColon + 1, secondColon), 10);
    if (!Number.isFinite(line)) continue;
    matches.push({
      path: toTreePath(row.slice(0, firstColon)),
      line,
      text: row.slice(secondColon + 1),
    });
  }
  return matches;
}

/**
 * Files whose leaf name contains `query` (case-insensitive), across the whole
 * repo file list, mapped to tree paths and capped at `limit`. Powers the
 * file-search box so matches aren't limited to the lazily-loaded/expanded tree.
 */
export function matchFileNames(
  files: readonly string[],
  query: string,
  limit: number,
): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const matches: string[] = [];
  for (const file of files) {
    const name = file.split("/").pop() ?? file;
    if (name.toLowerCase().includes(needle)) {
      matches.push(toTreePath(file));
      if (matches.length >= limit) break;
    }
  }
  return matches;
}

/** One run of a grep result line — `match` runs are the highlighted query. */
interface GrepHighlightSegment {
  text: string;
  match: boolean;
}

interface GrepHighlight {
  /** True when the prefix was clipped so the first match stays visible. */
  leadingEllipsis: boolean;
  segments: GrepHighlightSegment[];
}

/** Context characters kept before the first match when clipping a long line. */
const GREP_HIGHLIGHT_PREFIX = 24;

/**
 * Split a grep result line into highlighted/plain runs around each
 * case-insensitive occurrence of `query` (the search box does literal,
 * case-insensitive matching via ripgrep `-F -i`). Leading whitespace is
 * trimmed, and when the first match sits far into a long line the prefix is
 * clipped (`leadingEllipsis`) so the highlighted text stays visible under the
 * row's CSS truncation — mirroring VS Code's search results.
 */
export function buildGrepHighlight(
  lineText: string,
  query: string,
): GrepHighlight {
  const trimmed = lineText.replace(/^\s+/, "");
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return {
      leadingEllipsis: false,
      segments: [{ text: trimmed, match: false }],
    };
  }

  const first = trimmed.toLowerCase().indexOf(needle);
  if (first < 0) {
    return {
      leadingEllipsis: false,
      segments: [{ text: trimmed, match: false }],
    };
  }

  const leadingEllipsis = first > GREP_HIGHLIGHT_PREFIX;
  const clipped = leadingEllipsis
    ? trimmed.slice(first - GREP_HIGHLIGHT_PREFIX)
    : trimmed;
  const haystack = clipped.toLowerCase();

  const segments: GrepHighlightSegment[] = [];
  let cursor = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx < 0) {
      if (cursor < clipped.length) {
        segments.push({ text: clipped.slice(cursor), match: false });
      }
      break;
    }
    if (idx > cursor) {
      segments.push({ text: clipped.slice(cursor, idx), match: false });
    }
    segments.push({
      text: clipped.slice(idx, idx + needle.length),
      match: true,
    });
    cursor = idx + needle.length;
  }
  return { leadingEllipsis, segments };
}

/** Group content matches by file, preserving first-seen file order. */
export function groupGrepMatches(
  matches: readonly GrepContentMatch[],
): GrepFileGroup[] {
  const groups: GrepFileGroup[] = [];
  const byPath = new Map<string, GrepFileGroup>();
  for (const match of matches) {
    let group = byPath.get(match.path);
    if (!group) {
      group = { path: match.path, matches: [] };
      byPath.set(match.path, group);
      groups.push(group);
    }
    group.matches.push(match);
  }
  return groups;
}

/**
 * Strip the line-number prefix from the daemon's read endpoint.
 * The daemon returns content in `"1\tcontent\n2\tcontent"` format.
 *
 * Uses `replace` rather than a `(.*)` capture: `.` does not match `\r`,
 * \u2028, or \u2029, so a capture group would truncate any line containing
 * one of those (e.g. a JSON string value with an embedded line separator),
 * silently corrupting large files. `replace` drops only the `<n>\t` prefix
 * and keeps the rest of the line verbatim.
 */
export function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\d+\t/, ""))
    .join("\n");
}
