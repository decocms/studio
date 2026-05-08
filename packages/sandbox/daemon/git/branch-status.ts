import fs from "node:fs";
import type { Broadcaster } from "../events/broadcast";
import type { BranchStatus, BranchStatusReady, Config } from "../types";
import { gitSync as rawGitSync } from "./git-sync";

const gitSync = (args: string[], opts: Parameters<typeof rawGitSync>[1]) =>
  rawGitSync(["-c", "safe.directory=*", ...args], opts);

export class BranchStatusMonitor {
  private last: BranchStatus = { kind: "initializing" };
  private timer: ReturnType<typeof setTimeout> | null = null;
  private watcher: ReturnType<typeof fs.watch> | null = null;
  private pollFallback: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: Config,
    private readonly broadcaster: Broadcaster,
  ) {}

  getLast(): BranchStatus {
    return this.last;
  }

  /** Set a non-ready phase. Always broadcasts when the kind/payload changed. */
  setPhase(next: Exclude<BranchStatus, BranchStatusReady>): void {
    if (this.equal(this.last, next)) return;
    this.last = next;
    this.broadcast(next);
  }

  /**
   * Compute git status and enter 'ready'. Idempotent: skips broadcast when
   * the computed status equals the last 'ready' value. Starts the .git
   * watcher on first call.
   */
  markReady(): void {
    const next = this.compute();
    if (!next) return;
    if (this.equal(this.last, next)) return;
    this.last = next;
    this.broadcast(next);
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

  private broadcast(s: BranchStatus): void {
    this.broadcaster.broadcastEvent("branch-status", {
      type: "branch-status",
      ...s,
    });
  }

  private equal(a: BranchStatus, b: BranchStatus): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      // fs.watch fires meaningfully only once we're already in 'ready';
      // ignore otherwise (orchestrator owns non-ready transitions).
      if (this.last.kind === "ready") this.markReady();
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
        if (this.last.kind === "ready") this.markReady();
      }, 5000);
    }
  }

  private compute(): BranchStatusReady | null {
    const run = (args: string[]) => {
      try {
        return gitSync(args, {
          cwd: this.config.repoDir,
          // Pin discovery to repoDir so a parent .git (e.g. the host's
          // workspace tree containing .deco/sandboxes/<handle>/repo) can't
          // hijack the lookup and report the wrong branch.
          env: { ...process.env, GIT_CEILING_DIRECTORIES: this.config.repoDir },
        });
      } catch {
        return "";
      }
    };
    const refExists = (ref: string) =>
      run(["rev-parse", "--verify", "--quiet", ref]).length > 0;
    try {
      const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
      if (!branch || branch === "HEAD") return null;
      let base = run(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
      if (base.startsWith("origin/")) base = base.slice("origin/".length);
      if (!base) base = "main";
      const dirty = run(["status", "--porcelain=v1"]).length > 0;
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
