export interface GitStatusLike {
  modified: string[];
  created: string[];
  deleted: string[];
  not_added: string[];
}

export function isGitStatusLike(value: unknown): value is GitStatusLike {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.modified) &&
    Array.isArray(record.created) &&
    Array.isArray(record.deleted) &&
    Array.isArray(record.not_added)
  );
}

export interface GitDiffLike {
  diffs: Record<string, { from: string | null; to: string | null }>;
}

function isGeneratedNoise(path: string): boolean {
  return /^static\/.*\.css$/.test(path);
}

/** Paths from the working tree plus any keys in a base…head diff (committed PR work). */
function changedPaths(status: GitStatusLike, diff: GitDiffLike): string[] {
  const fromStatus = [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.not_added,
  ].filter((p) => !isGeneratedNoise(p));
  const fromDiff = Object.keys(diff.diffs).filter((p) => !isGeneratedNoise(p));
  return [...new Set([...fromStatus, ...fromDiff])];
}

function pathChangeKind(
  path: string,
  status: GitStatusLike,
  diff: GitDiffLike,
): "add" | "delete" | "update" {
  if (status.created.includes(path) || status.not_added.includes(path)) {
    return "add";
  }
  if (status.deleted.includes(path)) return "delete";
  const entry = diff.diffs[path];
  if (entry) {
    if (!entry.from && entry.to) return "add";
    if (entry.from && !entry.to) return "delete";
  }
  return "update";
}

function pathChangeLabel(
  path: string,
  status: GitStatusLike,
  diff: GitDiffLike,
): string {
  switch (pathChangeKind(path, status, diff)) {
    case "add":
      return `Added: ${path}`;
    case "delete":
      return `Deleted: ${path}`;
    case "update":
      return status.modified.includes(path)
        ? `Modified: ${path}`
        : `Changed: ${path}`;
  }
}

function changedLines(
  from: string | null,
  to: string | null,
  { context = 2, maxLines = 40 } = {},
): string {
  if (!from && !to) return "";
  if (!from) {
    return (to ?? "")
      .split("\n")
      .slice(0, maxLines)
      .map((l) => `+ ${l}`)
      .join("\n");
  }
  if (!to) {
    return from
      .split("\n")
      .slice(0, maxLines)
      .map((l) => `- ${l}`)
      .join("\n");
  }

  const a = from.split("\n").slice(0, 300);
  const b = to.split("\n").slice(0, 300);
  const n = a.length;
  const m = b.length;

  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0),
  );
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const prevRow = dp[i - 1];
      const cellLeft = prevRow?.[j] ?? 0;
      const cellUp = prevRow?.[j - 1] ?? 0;
      const prevDiag = prevRow?.[j - 1] ?? 0;
      const row = dp[i];
      if (!row) continue;
      const aLine = a[i - 1];
      const bLine = b[j - 1];
      row[j] =
        aLine !== undefined && bLine !== undefined && aLine === bLine
          ? prevDiag + 1
          : Math.max(cellLeft, cellUp);
    }
  }

  type Op = { op: "=" | "+" | "-"; line: string };
  const ops: Op[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const aLine = i > 0 ? a[i - 1] : undefined;
    const bLine = j > 0 ? b[j - 1] : undefined;
    const row = dp[i];
    const prevRow = dp[i - 1];
    if (
      i > 0 &&
      j > 0 &&
      aLine !== undefined &&
      bLine !== undefined &&
      aLine === bLine
    ) {
      ops.unshift({ op: "=", line: aLine });
      i--;
      j--;
    } else if (
      j > 0 &&
      (i === 0 || (row?.[j - 1] ?? 0) >= (prevRow?.[j] ?? 0))
    ) {
      if (bLine !== undefined) ops.unshift({ op: "+", line: bLine });
      j--;
    } else if (aLine !== undefined) {
      ops.unshift({ op: "-", line: aLine });
      i--;
    } else {
      break;
    }
  }

  const show = new Set<number>();
  ops.forEach((op, idx) => {
    if (op.op !== "=") {
      for (
        let c = Math.max(0, idx - context);
        c <= Math.min(ops.length - 1, idx + context);
        c++
      ) {
        show.add(c);
      }
    }
  });

  if (show.size === 0) return "";

  const result: string[] = [];
  let last = -1;
  for (const idx of [...show].sort((a, b) => a - b)) {
    if (last !== -1 && idx > last + 1) result.push("@@ ... @@");
    const opEntry = ops[idx];
    if (!opEntry) continue;
    const { op, line } = opEntry;
    result.push(`${op === "=" ? " " : op} ${line}`);
    last = idx;
    if (result.length >= maxLines) break;
  }

  return result.join("\n");
}

export function buildChangeContextSummary(
  status: GitStatusLike,
  diff: GitDiffLike,
): string {
  const paths = changedPaths(status, diff);
  const fileLines = paths
    .map((p) => pathChangeLabel(p, status, diff))
    .join("\n");

  const snippets = paths
    .map((path) => {
      const entry = diff.diffs[path];
      if (!entry) return path;
      const snippet = changedLines(entry.from, entry.to);
      return snippet ? `${path}:\n${snippet}` : path;
    })
    .join("\n---\n");

  return `Changed files:\n${fileLines}\n\nDiff snippets:\n${snippets}`;
}
