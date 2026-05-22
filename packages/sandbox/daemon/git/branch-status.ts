import fs from "node:fs";
import type { Broadcaster } from "../events/broadcast";
import type { BranchMeta } from "../events/types";
import type { Config } from "../types";
import { gitSync as rawGitSync } from "./git-sync";

const gitSync = (args: string[], opts: Parameters<typeof rawGitSync>[1]) =>
  rawGitSync(["-c", "safe.directory=*", ...args], opts);

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
 * paths in that snapshot are subtracted from subsequent dirty checks.
 */
export class BranchStatusMonitor {
  private last: BranchMeta = { kind: "unknown" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watcher: ReturnType<typeof fs.watch> | null = null;
  private pollFallback: ReturnType<typeof setInterval> | null = null;
  /** Paths reported dirty by `git status --porcelain=v1` at boot — treated as noise. */
  private dirtyBaseline: ReadonlySet<string> | null = null;

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
    this.dirtyBaseline = this.readDirtyPaths();
    // Re-evaluate so the next emit reflects the new filter.
    this.refresh();
  }

  clearBaseline(): void {
    if (this.dirtyBaseline === null) return;
    this.dirtyBaseline = null;
    this.refresh();
  }

  /**
   * Compute git status and emit it. Idempotent — skips broadcast when the
   * computed meta matches `last`. Starts the .git watcher on first call.
   */
  refresh(): void {
    const next = this.compute();
    if (!next) return;
    if (equal(this.last, next)) return;
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
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.pollFallback) {
      clearInterval(this.pollFallback);
      this.pollFallback = null;
    }
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
    if (this.watcher || this.pollFallback) return;
    const gitDir = `${this.config.repoDir}/.git`;
    try {
      this.watcher = fs.watch(gitDir, { recursive: true }, () =>
        this.schedule(),
      );
      // Swallow errors (e.g. ENOENT when .git is removed during shutdown)
      // — without this the FSWatcher emits an unhandled 'error' event.
      this.watcher.on("error", () => {});
    } catch {
      this.pollFallback = setInterval(() => {
        if (this.last.kind === "ready") this.refresh();
      }, 5000);
    }
  }

  private runGit(args: string[]): string {
    try {
      return gitSync(args, {
        cwd: this.config.repoDir,
        // Pin discovery to repoDir so a parent .git (e.g. the host's
        // workspace tree containing link/sandboxes/<handle>/repo) can't
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

  private compute(): Extract<BranchMeta, { kind: "ready" }> | null {
    const run = (args: string[]) => this.runGit(args);
    const refExists = (ref: string) =>
      run(["rev-parse", "--verify", "--quiet", ref]).length > 0;
    try {
      const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!branch || branch === "HEAD") return null;
      let base = run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      if (base.startsWith("origin/")) base = base.slice("origin/".length);
      if (!base) base = "main";
      const dirtyPaths = this.readDirtyPaths();
      const baseline = this.dirtyBaseline;
      const dirty = baseline
        ? [...dirtyPaths].some((p) => !baseline.has(p))
        : dirtyPaths.size > 0;
      const branchRef = refExists(`origin/${branch}`)
        ? `origin/${branch}`
        : "HEAD";
      const unpushed =
        branchRef === `origin/${branch}`
          ? Number(
              run(["rev-list", "--count", `origin/${branch}..HEAD`]) || "0",
            )
          : 0;
      let aheadOfBase = 0;
      let behindBase = 0;
      if (refExists(`origin/${base}`)) {
        const lr = run([
          "rev-list",
          "--left-right",
          "--count",
          `origin/${base}...${branchRef}`,
        ]);
        const m = lr.match(/^(\d+)\s+(\d+)$/);
        if (m) {
          behindBase = Number(m[1]);
          aheadOfBase = Number(m[2]);
        }
      }
      const headSha = run(["rev-parse", branchRef]);
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

/**
 * Parse `git status --porcelain=v1 -z` output into a set of paths.
 * Format: each entry is `XY <path>\0`. Renames/copies (`R`/`C`) carry a
 * second `<orig>\0` after the destination — we record both so a baseline
 * captures whichever one a later run sees.
 */
function parsePorcelainZ(out: string): Set<string> {
  const paths = new Set<string>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    paths.add(path);
    // Renames/copies have an extra origin-path field.
    if (xy[0] === "R" || xy[0] === "C") {
      i++;
      const orig = parts[i];
      if (orig) paths.add(orig);
    }
  }
  return paths;
}
