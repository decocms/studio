import type { FlatNode, TreeNode } from "./types";

export function normalizePath(path: string) {
  if (!path.trim()) {
    return "/";
  }
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return normalized.replace(/\/+/g, "/");
}

export function getBasename(path: string) {
  const normalized = normalizePath(path);
  return normalized.split("/").filter(Boolean).pop() ?? "/";
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

export function buildFileTree(files: string[]): TreeNode[] {
  const root: TreeNode = {
    name: "/",
    path: "/",
    kind: "directory",
    children: [],
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
