import type { BranchMeta } from "../events/types";
import {
  ensureOriginPushable,
  type GitDeps,
  pushBranchAsync,
  stageAndCommit,
} from "../routes/git";
import { protectedBranches } from "./protect-branch";

/**
 * Trailing debounce after a repo file change — the primary trigger, so a save
 * normally lands a few seconds after the agent stops writing.
 *
 * Not zero: one commit+push per file write would mean a push every few hundred
 * ms during a tool loop, and a push to a user's repo can fan out into their CI.
 * Coalescing a burst into one save costs a few seconds of exposure and cuts the
 * push count by an order of magnitude.
 */
const AUTO_COMMIT_DEBOUNCE_MS = 5_000;

/**
 * Periodic floor, and the real worst-case window of work lost to a SIGKILL.
 * Needed because the debounce alone can't be trusted:
 *  - continuous writing keeps resetting it, so it may never fire during a long
 *    run — this interval is what bounds the loss window there;
 *  - the change signal comes from fs.watch, which has real gaps (the same
 *    reason BranchStatusMonitor keeps its own 3 s poll fallback);
 *  - commits the agent makes itself via `bash` produce no file-change event at
 *    all, only `unpushed > 0`.
 *
 * ponytail: fixed values, no adaptive backoff. A clean tree costs zero git
 * calls (the tick reads BranchStatusMonitor's already-computed meta), so there
 * is nothing to tune until someone measures a problem.
 */
const AUTO_COMMIT_INTERVAL_MS = 30_000;

const COMMIT_MESSAGE = "chore(sandbox): auto-save work in progress";

/** Should this tick do anything? Extracted so the decision is unit-testable. */
export function shouldAutoCommit(
  meta: BranchMeta,
  protectedBranchNames: ReadonlySet<string>,
): boolean {
  if (meta.kind !== "ready") return false;
  // stageAndCommit() refuses a protected branch anyway; bail here so a sandbox
  // sitting on main doesn't log a warning every tick for the whole session.
  if (protectedBranchNames.has(meta.branch)) return false;
  // `unpushed` covers commits the agent made itself via bash — those are just
  // as lost as uncommitted work if the remote never sees them.
  return meta.workingTreeDirty || meta.unpushed > 0;
}

export interface AutoCommitterDeps {
  gitDeps: GitDeps;
  /** Current branch metadata, from BranchStatusMonitor (no extra git calls). */
  getBranchMeta: () => BranchMeta;
  /**
   * Read per tick, not at start(): tenant config arrives after boot (PUT
   * /config) and can change mid-session, so a start-time snapshot would pin
   * the wrong value.
   */
  isEnabled: () => boolean;
  /** Re-read git state after a commit so the UI's dirty flag settles. */
  onSynced?: () => void;
  /** Overridable so tests don't wait out the real debounce. */
  debounceMs?: number;
}

/**
 * Commits and pushes the sandbox's working tree so a SIGKILL (pod eviction,
 * OOM, node loss) can't take the agent's work with it. Change-driven
 * (`nudge()`, debounced) with a periodic floor. Reuses publish()'s staging
 * rules and its non-reconciling push, so it inherits the protected-branch
 * refusal, the invalid-decofile-block skip, and credentialed origin setup.
 */
export class AutoCommitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly deps: AutoCommitterDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), AUTO_COMMIT_INTERVAL_MS);
    // Don't hold the process open on this timer alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.debounce) {
      clearTimeout(this.debounce);
      this.debounce = null;
    }
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * A repo file changed — save once the writes settle. Trailing debounce: a
   * burst (one agent turn writing 20 files) coalesces into a single commit, and
   * writes that never settle are picked up by the interval instead.
   */
  nudge(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.tick();
    }, this.deps.debounceMs ?? AUTO_COMMIT_DEBOUNCE_MS);
    this.debounce.unref?.();
  }

  /** One pass. Exposed for tests; never throws. */
  async tick(): Promise<void> {
    // Overlapping passes would race for index.lock, and a slow push must not
    // queue up a second commit behind it.
    if (this.running) return;
    if (!this.deps.isEnabled()) return;
    const meta = this.deps.getBranchMeta();
    if (!shouldAutoCommit(meta, protectedBranches(this.deps.gitDeps.repoDir))) {
      return;
    }
    this.running = true;
    try {
      // "skip", not "throw": one invalid decofile block must not stop the rest
      // of the tree from being saved (same call as the shutdown sync).
      //
      // Asymmetry on purpose: the TRIGGER above ignores boot-dirty noise (dev
      // server rewriting compiled assets — BranchStatusMonitor's baseline),
      // but the commit stages everything dirty, exactly like the shutdown
      // sync. Carrying a little noise beats dropping the user's work.
      const prepared = stageAndCommit(this.deps.gitDeps, COMMIT_MESSAGE, {
        onInvalidBlock: "skip",
      });
      if (!prepared) return;
      if (prepared.committed) this.deps.onSynced?.();
      ensureOriginPushable(this.deps.gitDeps);
      await pushBranchAsync(this.deps.gitDeps.repoDir, prepared.branch);
    } catch (err) {
      // Best-effort by design: a protected branch, a diverged origin, or a
      // missing credential all land here. The next tick retries, and the
      // shutdown publish is the backstop — never crash the daemon over it.
      console.warn("[daemon] auto-commit failed", err);
    } finally {
      this.running = false;
    }
  }
}
