import type { FlatNode, TreeNode } from "./types";

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
  if (trimmed.startsWith(".")) {
    return "Name cannot start with a dot";
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
    getPathDepth(treePath) > EXPLORER_EAGER_DEPTH &&
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
  try {
    return decodeURIComponent(stem);
  } catch {
    return stem;
  }
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

  const ensureDirectory = (dirPath: string) => {
    const normalized = normalizePath(dirPath);
    const parts = normalized.split("/").filter(Boolean);
    let current = root;
    let currentPath = "";

    for (const part of parts) {
      currentPath += `/${part}`;
      let child = current.children.find((entry) => entry.name === part);
      if (!child) {
        child = {
          name: part,
          path: currentPath,
          kind: "directory",
          children: [],
        };
        current.children.push(child);
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
      let child = current.children.find((entry) => entry.name === part);

      if (!child) {
        child = {
          name: part,
          path: currentPath,
          kind: isFile ? "file" : "directory",
          children: [],
        };
        current.children.push(child);
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

/**
 * Strip the line-number prefix from the daemon's read endpoint.
 * The daemon returns content in `"1\tcontent\n2\tcontent"` format.
 */
export function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => {
      const match = line.match(/^\d+\t(.*)/);
      return match ? match[1] : line;
    })
    .join("\n");
}
