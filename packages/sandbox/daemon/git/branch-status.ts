import { createHash } from "node:crypto";
import fs from "node:fs";
import { join } from "node:path";
import type { Broadcaster } from "../events/broadcast";
import type { BranchMeta } from "../events/types";
import type { Config } from "../types";
import { computeBranchDivergence } from "./branch-divergence";
import { gitSync as rawGitSync } from "./git-sync";
import { parsePorcelainZ } from "./porcelain";

const gitSync = (args: string[], opts: Parameters<typeof rawGitSync>[1]) =>
  rawGitSync(["-c", "safe.directory=*", ...args], opts);

/** Set DEBUG_SAVE_CHANGES=1 to trace dirty-state / Save-changes button logic. */
function branchDebug(message: string, data?: Record<string, unknown>): void {
  if (process.env.DEBUG_SAVE_CHANGES !== "1") return;
  console.log(`[branch-status] ${message}`, data ?? "");
}

/**
 * Watches `.git/` and surfaces the current `BranchMeta` (branch name, dirty,
 * unpushed, divergence). Lifecycle phases (cloning, checking-out, …) live on
 * `LifecycleManager`, not here — this monitor only tracks metadata once the
 * repo is in a checkable state.
 *
 * Dirty-baseline: dev scripts often rewrite tracked files at boot (e.g.
 * minified `static/tailwind.css`, compiled CSS, lockfile drift after
 * `npm/bun install`). Those touches are not user changes, but they show up
 * in `git status` and would flip `workingTreeDirty=true` the moment the dev
 * server settles. To avoid false-positive "Save changes" buttons, the
 * orchestrator calls `armBaseline()` once `lifecycle: running` stabilizes;
 * a content hash snapshot is stored per boot-dirty path so later edits to
 * those same files still flip `workingTreeDirty` (path-only filtering hid
 * user saves on files the dev server had already touched).
 */
export class BranchStatusMonitor {
  private last: BranchMeta = { kind: "unknown" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private gitWatcher: ReturnType<typeof fs.watch> | null = null;
  private repoWatcher: ReturnType<typeof fs.watch> | null = null;
  private pollFallback: ReturnType<typeof setInterval> | null = null;
  private watchInitialized = false;
  /** Boot-dirty paths → working-tree content hash at `armBaseline()`. */
  private dirtyBaseline: Map<string, string> | null = null;

  constructor(
    private readonly config: Config,
    private readonly broadcaster: Broadcaster,
  ) {}

  getLast(): BranchMeta {
    return this.last;
  }

  /**
   * Capture the current dirty set as the noise baseline. Call once the dev
   * server has settled (probe online → transitioned to `running`) so any
   * boot-time file rewrites land in the baseline. Re-arming overwrites the
   * prior snapshot. `clearBaseline()` drops it on a fresh clone/install.
   */
  armBaseline(): void {
    const paths = this.readDirtyPaths();
    this.dirtyBaseline = new Map();
    for (const p of paths) {
      this.dirtyBaseline.set(p, this.hashWorktreeFile(p));
    }
    branchDebug("armBaseline", {
      repoDir: this.config.repoDir,
      baselinePaths: [...this.dirtyBaseline.keys()],
    });
    // Re-evaluate so the next emit reflects the new filter.
    this.refresh();
  }

  clearBaseline(): void {
    if (this.dirtyBaseline === null) return;
    branchDebug("clearBaseline", { repoDir: this.config.repoDir });
    this.dirtyBaseline = null;
    this.refresh();
  }

  /**
   * Compute git status and emit it. Idempotent — skips broadcast when the
   * computed meta matches `last`. Starts the .git watcher on first call.
   */
  refresh(): void {
    const next = this.compute();
    if (!next) {
      branchDebug(
        "refresh: compute returned null (no git repo or detached HEAD?)",
        {
          repoDir: this.config.repoDir,
          lastKind: this.last.kind,
        },
      );
      return;
    }
    if (equal(this.last, next)) return;
    branchDebug("refresh: emit branch event", next);
    this.last = next;
    this.broadcaster.emit("branch", { meta: next });
    this.ensureWatch();
  }

  /** Stop the .git watcher and any polling fallback. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.gitWatcher) {
      this.gitWatcher.close();
      this.gitWatcher = null;
    }
    if (this.repoWatcher) {
      this.repoWatcher.close();
      this.repoWatcher = null;
    }
    if (this.pollFallback) {
      clearInterval(this.pollFallback);
      this.pollFallback = null;
    }
    this.watchInitialized = false;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // fs.watch fires meaningfully only once we're already in 'ready';
      // ignore otherwise (orchestrator owns pre-ready transitions).
      if (this.last.kind === "ready") this.refresh();
    }, 250);
  }

  private ensureWatch(): void {
    if (this.watchInitialized) return;
    this.watchInitialized = true;

    const gitDir = `${this.config.repoDir}/.git`;
    try {
      this.gitWatcher = fs.watch(gitDir, { recursive: true }, () =>
        this.schedule(),
      );
      this.gitWatcher.on("error", () => {});
    } catch {
      // Swallow — poll fallback below covers git-dir watch gaps.
    }

    // Working-tree edits (file explorer, agent write/edit) don't touch
    // `.git/` until staged, so a git-dir-only watch never flips
    // `workingTreeDirty`. Watch the repo tree too.
    try {
      this.repoWatcher = fs.watch(
        this.config.repoDir,
        { recursive: true },
        (_event, filename) => {
          if (
            typeof filename === "string" &&
            (filename === ".git" || filename.startsWith(".git/"))
          ) {
            return;
          }
          this.schedule();
        },
      );
      this.repoWatcher.on("error", () => {});
    } catch {
      // Non-recursive platforms fall through to poll.
    }

    // Safety net for atomic editor saves and watch gaps on Linux.
    this.pollFallback = setInterval(() => {
      if (this.last.kind === "ready") this.refresh();
    }, 3000);
    branchDebug("ensureWatch", {
      repoDir: this.config.repoDir,
      gitWatcher: Boolean(this.gitWatcher),
      repoWatcher: Boolean(this.repoWatcher),
      pollMs: 3000,
    });
  }

  private runGit(args: string[]): string {
    try {
      return gitSync(args, {
        cwd: this.config.repoDir,
        // Pin discovery to repoDir so a parent .git (e.g. the host's
        // workspace tree containing sandboxes/<handle>/repo) can't
        // hijack the lookup and report the wrong branch.
        env: { ...process.env, GIT_CEILING_DIRECTORIES: this.config.repoDir },
      });
    } catch {
      return "";
    }
  }

  /** Paths currently shown by porcelain v1. Empty set on clean tree or git failure. */
  private readDirtyPaths(): Set<string> {
    const out = this.runGit(["status", "--porcelain=v1", "-z"]);
    if (!out) return new Set();
    return parsePorcelainZ(out);
  }

  private hashWorktreeFile(path: string): string {
    try {
      const buf = fs.readFileSync(join(this.config.repoDir, path));
      return createHash("sha256").update(buf).digest("hex");
    } catch {
      return "";
    }
  }

  private isWorkingTreeDirty(dirtyPaths: Set<string>): {
    dirty: boolean;
    changedPaths: string[];
  } {
    if (dirtyPaths.size === 0) return { dirty: false, changedPaths: [] };
    const baseline = this.dirtyBaseline;
    if (!baseline) {
      return { dirty: true, changedPaths: [...dirtyPaths] };
    }
    const changedPaths: string[] = [];
    for (const p of dirtyPaths) {
      const hash = this.hashWorktreeFile(p);
      const baseHash = baseline.get(p);
      if (baseHash === undefined || hash !== baseHash) {
        changedPaths.push(p);
      }
    }
    return { dirty: changedPaths.length > 0, changedPaths };
  }

  private compute(): Extract<BranchMeta, { kind: "ready" }> | null {
    try {
      const branch = this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!branch || branch === "HEAD") return null;

      const tryGit = (args: string[]) => {
        const out = this.runGit(args);
        return out.length > 0 ? out : null;
      };
      const { base, unpushed, aheadOfBase, behindBase, headSha } =
        computeBranchDivergence(this.config.repoDir, tryGit);

      const dirtyPaths = this.readDirtyPaths();
      const baseline = this.dirtyBaseline;
      const { dirty, changedPaths } = this.isWorkingTreeDirty(dirtyPaths);
      if (dirtyPaths.size > 0 || dirty) {
        branchDebug("compute", {
          branch,
          base,
          dirtyPaths: [...dirtyPaths],
          baselinePaths: baseline ? [...baseline.keys()] : null,
          changedPaths,
          workingTreeDirty: dirty,
        });
      }

      return {
        kind: "ready",
        branch,
        base,
        workingTreeDirty: dirty,
        unpushed,
        aheadOfBase,
        behindBase,
        headSha,
      };
    } catch {
      return null;
    }
  }
}

function equal(a: BranchMeta, b: BranchMeta): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
