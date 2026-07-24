import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";

export type LinkSandboxStatus =
  | "spawning"
  | "ready"
  | "failed"
  | "stopped"
  | "missing"
  | "merged"
  | "invalid";

export interface SandboxInspection {
  handle: string;
  branch: string | null;
  sandboxPath: string;
  dirtyCount: number;
  merged: boolean | null;
}

export interface LinkSandboxRecord {
  handle: string;
  status: LinkSandboxStatus;
  sandboxPath: string;
  port: number | null;
  previewUrl: string | null;
  repoCloneUrl: string | null;
  branch: string | null;
  projectName: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number | null;
  missingSince: number | null;
}

export interface LinkSandboxUpsert {
  handle: string;
  status: LinkSandboxStatus;
  sandboxPath: string;
  port?: number | null;
  previewUrl?: string | null;
  repoCloneUrl?: string | null;
  branch?: string | null;
  projectName?: string | null;
  error?: string | null;
}

export interface LinkSandboxPruneOptions {
  missing: boolean;
  merged: boolean;
}

export interface LinkSandboxPruneItem {
  handle: string;
  sandboxPath: string;
  reason:
    | "missing"
    | "merged"
    | "outside_root"
    | "branch_not_merged"
    | "dirty_worktree"
    | "git_unavailable"
    | "no_branch";
  deletedFiles: boolean;
}

export interface LinkSandboxPruneResult {
  removed: LinkSandboxPruneItem[];
  skipped: LinkSandboxPruneItem[];
}

export interface LinkSandboxRegistry {
  upsert(row: LinkSandboxUpsert): void;
  list(): LinkSandboxRecord[];
  reconcile(): LinkSandboxRecord[];
  prune(options: LinkSandboxPruneOptions): LinkSandboxPruneResult;
  delete(handle: string): void;
  inspect(handle: string): SandboxInspection | null;
  close(): void;
}

interface LinkSandboxDbRow {
  handle: string;
  status: string;
  sandbox_path: string;
  port: number | null;
  preview_url: string | null;
  repo_clone_url: string | null;
  branch: string | null;
  project_name: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  missing_since: number | null;
}

function toRecord(row: LinkSandboxDbRow): LinkSandboxRecord {
  return {
    handle: row.handle,
    status: row.status as LinkSandboxStatus,
    sandboxPath: row.sandbox_path,
    port: row.port,
    previewUrl: row.preview_url,
    repoCloneUrl: row.repo_clone_url,
    branch: row.branch,
    projectName: row.project_name,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    missingSince: row.missing_since,
  };
}

function runGit(
  cwd: string,
  args: string[],
): { ok: true; stdout: string } | { ok: false; code: number | null } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, code: result.status };
  }
  return { ok: true, stdout: result.stdout };
}

function gitRefExists(cwd: string, ref: string): boolean {
  return runGit(cwd, ["show-ref", "--verify", "--quiet", ref]).ok;
}

function gitCommitExists(cwd: string, rev: string): boolean {
  return runGit(cwd, ["rev-parse", "--verify", `${rev}^{commit}`]).ok;
}

function detectDefaultBranch(cwd: string): string | null {
  const originHead = runGit(cwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (originHead.ok) {
    const ref = originHead.stdout.trim();
    if (ref && gitCommitExists(cwd, ref)) return ref;
  }

  for (const ref of ["main", "master", "trunk", "develop"]) {
    if (gitRefExists(cwd, `refs/heads/${ref}`) && gitCommitExists(cwd, ref)) {
      return ref;
    }
  }

  return null;
}

function branchIsMergedIntoDefault(
  cwd: string,
  branch: string,
): boolean | null {
  if (!runGit(cwd, ["rev-parse", "--verify", `${branch}^{commit}`]).ok) {
    return null;
  }

  const defaultBranch = detectDefaultBranch(cwd);
  if (defaultBranch === null) {
    return null;
  }

  const mergeBase = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", branch, defaultBranch],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (mergeBase.error !== undefined) {
    return null;
  }
  if (mergeBase.status === 0) return true;
  if (mergeBase.status === 1) return false;
  return null;
}

export function registryPathForDataDir(dataDir: string): string {
  return join(dataDir, "link", "sandboxes.sqlite");
}

export function openLinkSandboxRegistry(opts: {
  path: string;
  managedSandboxRoot?: string;
}): LinkSandboxRegistry {
  if (opts.path !== ":memory:") {
    mkdirSync(dirname(opts.path), { recursive: true });
  }

  const db = new Database(opts.path, { create: true });
  const managedSandboxRoot =
    opts.managedSandboxRoot === undefined
      ? undefined
      : resolve(opts.managedSandboxRoot);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS link_sandboxes (
      handle         TEXT    NOT NULL PRIMARY KEY,
      status         TEXT    NOT NULL CHECK (
        status IN (
          'spawning',
          'ready',
          'failed',
          'stopped',
          'missing',
          'merged',
          'invalid'
        )
      ),
      sandbox_path   TEXT    NOT NULL,
      port           INTEGER,
      preview_url    TEXT,
      repo_clone_url TEXT,
      branch         TEXT,
      project_name   TEXT,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL,
      last_seen_at   INTEGER,
      missing_since  INTEGER
    )
  `);

  const upsertStmt = db.query(`
    INSERT INTO link_sandboxes (
      handle,
      status,
      sandbox_path,
      port,
      preview_url,
      repo_clone_url,
      branch,
      project_name,
      error,
      created_at,
      updated_at,
      last_seen_at,
      missing_since
    )
    VALUES (
      $handle,
      $status,
      $sandboxPath,
      $port,
      $previewUrl,
      $repoCloneUrl,
      $branch,
      $projectName,
      $error,
      $now,
      $now,
      CASE
        WHEN $status NOT IN ('missing', 'invalid') THEN $now
        ELSE NULL
      END,
      CASE
        WHEN $status = 'missing' THEN $now
        ELSE NULL
      END
    )
    ON CONFLICT(handle) DO UPDATE SET
      status = excluded.status,
      sandbox_path = excluded.sandbox_path,
      port = excluded.port,
      preview_url = excluded.preview_url,
      -- Keep source metadata sticky across status-only updates; callers may
      -- omit these fields when reporting lifecycle changes.
      repo_clone_url = COALESCE(
        excluded.repo_clone_url,
        link_sandboxes.repo_clone_url
      ),
      branch = COALESCE(excluded.branch, link_sandboxes.branch),
      project_name = COALESCE(
        excluded.project_name,
        link_sandboxes.project_name
      ),
      error = excluded.error,
      updated_at = excluded.updated_at,
      last_seen_at = CASE
        WHEN excluded.status NOT IN ('missing', 'invalid')
          THEN excluded.updated_at
        ELSE link_sandboxes.last_seen_at
      END,
      missing_since = CASE
        WHEN excluded.status = 'missing' THEN excluded.updated_at
        WHEN excluded.status NOT IN ('missing', 'invalid') THEN NULL
        ELSE link_sandboxes.missing_since
      END
  `);

  const listStmt = db.query<LinkSandboxDbRow, []>(`
    SELECT
      handle,
      status,
      sandbox_path,
      port,
      preview_url,
      repo_clone_url,
      branch,
      project_name,
      error,
      created_at,
      updated_at,
      last_seen_at,
      missing_since
    FROM link_sandboxes
    ORDER BY updated_at DESC, handle ASC
  `);

  const markInvalidStmt = db.query(`
    UPDATE link_sandboxes
    SET
      status = 'invalid',
      port = NULL,
      preview_url = NULL,
      error = 'sandbox path is outside the managed sandbox root',
      updated_at = $now
    WHERE handle = $handle
  `);

  const markMissingStmt = db.query(`
    UPDATE link_sandboxes
    SET
      status = 'missing',
      port = NULL,
      preview_url = NULL,
      error = NULL,
      updated_at = $now,
      missing_since = COALESCE(missing_since, $now)
    WHERE handle = $handle
  `);

  const markStoppedStmt = db.query(`
    UPDATE link_sandboxes
    SET
      status = 'stopped',
      port = NULL,
      preview_url = NULL,
      error = NULL,
      updated_at = $now,
      last_seen_at = $now,
      missing_since = NULL
    WHERE handle = $handle
  `);

  const deleteStmt = db.query(`
    DELETE FROM link_sandboxes
    WHERE handle = $handle
  `);

  const getStmt = db.query(`
    SELECT * FROM link_sandboxes WHERE handle = $handle
  `);

  function sandboxPathIsInsideManagedRoot(sandboxPath: string): boolean {
    if (managedSandboxRoot === undefined) {
      return true;
    }

    const sandboxPathExists = existsSync(sandboxPath);
    const rootPath =
      sandboxPathExists && existsSync(managedSandboxRoot)
        ? realpathSync(managedSandboxRoot)
        : managedSandboxRoot;
    const candidatePath = sandboxPathExists
      ? realpathSync(sandboxPath)
      : resolve(sandboxPath);
    const relativePath = relative(rootPath, candidatePath);
    return (
      relativePath === "" ||
      (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    );
  }

  return {
    upsert(row) {
      upsertStmt.run({
        $handle: row.handle,
        $status: row.status,
        $sandboxPath: row.sandboxPath,
        $port: row.port ?? null,
        $previewUrl: row.previewUrl ?? null,
        $repoCloneUrl: row.repoCloneUrl ?? null,
        $branch: row.branch ?? null,
        $projectName: row.projectName ?? null,
        $error: row.error ?? null,
        $now: Date.now(),
      });
    },
    list() {
      return listStmt.all().map(toRecord);
    },
    reconcile() {
      const now = Date.now();

      for (const row of listStmt.all().map(toRecord)) {
        if (!sandboxPathIsInsideManagedRoot(row.sandboxPath)) {
          markInvalidStmt.run({ $handle: row.handle, $now: now });
          continue;
        }

        if (!existsSync(row.sandboxPath)) {
          markMissingStmt.run({ $handle: row.handle, $now: now });
          continue;
        }

        if (
          row.status === "spawning" ||
          row.status === "ready" ||
          row.status === "failed" ||
          row.status === "missing"
        ) {
          markStoppedStmt.run({ $handle: row.handle, $now: now });
        }
      }

      return listStmt.all().map(toRecord);
    },
    prune(options) {
      const removed: LinkSandboxPruneItem[] = [];
      const skipped: LinkSandboxPruneItem[] = [];
      const rows = this.reconcile();

      for (const row of rows) {
        if (!sandboxPathIsInsideManagedRoot(row.sandboxPath)) {
          skipped.push({
            handle: row.handle,
            sandboxPath: row.sandboxPath,
            reason: "outside_root",
            deletedFiles: false,
          });
          continue;
        }

        if (options.missing && row.status === "missing") {
          deleteStmt.run({ $handle: row.handle });
          removed.push({
            handle: row.handle,
            sandboxPath: row.sandboxPath,
            reason: "missing",
            deletedFiles: false,
          });
          continue;
        }

        if (!options.merged || !existsSync(row.sandboxPath)) {
          continue;
        }

        if (row.branch === null || row.branch.trim() === "") {
          skipped.push({
            handle: row.handle,
            sandboxPath: row.sandboxPath,
            reason: "no_branch",
            deletedFiles: false,
          });
          continue;
        }

        if (
          !runGit(row.sandboxPath, ["rev-parse", "--is-inside-work-tree"]).ok
        ) {
          skipped.push({
            handle: row.handle,
            sandboxPath: row.sandboxPath,
            reason: "git_unavailable",
            deletedFiles: false,
          });
          continue;
        }

        const status = runGit(row.sandboxPath, ["status", "--porcelain"]);
        if (!status.ok) {
          skipped.push({
            handle: row.handle,
            sandboxPath: row.sandboxPath,
            reason: "git_unavailable",
            deletedFiles: false,
          });
          continue;
        }
        if (status.stdout.trim() !== "") {
          skipped.push({
            handle: row.handle,
            sandboxPath: row.sandboxPath,
            reason: "dirty_worktree",
            deletedFiles: false,
          });
          continue;
        }

        const merged = branchIsMergedIntoDefault(row.sandboxPath, row.branch);
        if (merged === null) {
          skipped.push({
            handle: row.handle,
            sandboxPath: row.sandboxPath,
            reason: "git_unavailable",
            deletedFiles: false,
          });
          continue;
        }
        if (!merged) {
          skipped.push({
            handle: row.handle,
            sandboxPath: row.sandboxPath,
            reason: "branch_not_merged",
            deletedFiles: false,
          });
          continue;
        }

        rmSync(row.sandboxPath, { recursive: true, force: true });
        deleteStmt.run({ $handle: row.handle });
        removed.push({
          handle: row.handle,
          sandboxPath: row.sandboxPath,
          reason: "merged",
          deletedFiles: true,
        });
      }

      return { removed, skipped };
    },
    delete(handle) {
      deleteStmt.run({ $handle: handle });
    },
    inspect(handle) {
      const row = getStmt.get({ $handle: handle }) as LinkSandboxDbRow | null;
      if (row === null) return null;
      const rec = toRecord(row);
      let dirtyCount = 0;
      let merged: boolean | null = null;
      if (
        existsSync(rec.sandboxPath) &&
        runGit(rec.sandboxPath, ["rev-parse", "--is-inside-work-tree"]).ok
      ) {
        const status = runGit(rec.sandboxPath, ["status", "--porcelain"]);
        if (status.ok) {
          const trimmed = status.stdout.trim();
          dirtyCount = trimmed === "" ? 0 : trimmed.split("\n").length;
        }
        if (rec.branch !== null && rec.branch.trim() !== "") {
          merged = branchIsMergedIntoDefault(rec.sandboxPath, rec.branch);
        }
      }
      return {
        handle: rec.handle,
        branch: rec.branch,
        sandboxPath: rec.sandboxPath,
        dirtyCount,
        merged,
      };
    },
    close() {
      db.close();
    },
  };
}
