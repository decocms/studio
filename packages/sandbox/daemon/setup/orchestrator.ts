import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../persistence";
import type { TenantConfigStore } from "../config-store";
import type { TaskManager } from "../process/task-manager";
import type { Transition } from "../config-store/types";
import {
  PACKAGE_MANAGER_DAEMON_CONFIG,
  WELL_KNOWN_STARTERS,
  buildDevEnv,
  isSyntheticBranch,
  pmRunCommand,
} from "../constants";
import type { Broadcaster } from "../events/broadcast";
import type { DaemonStatus } from "../events/types";
import type { BranchStatusMonitor } from "../git/branch-status";
import { ensureGitExclude } from "../git-exclude";
import { gitSync } from "../git/git-sync";
import { spawnCheckoutBranch } from "../git/checkout-branch";
import { syncOriginRemote } from "../git/sync-origin-remote";
import type { InstallState } from "../install/install-state";
import { InstallState as InstallStateClass } from "../install/install-state";
import type { LifecycleManager } from "../lifecycle/manager";
import { LogTee } from "../process/log-tee";
import { appLogPath, hasGitRepo, resolvePmRoot } from "../paths";
import { discoverScripts } from "../process/script-discovery";
import { withPathDirs } from "../process/structured-command";
import type { Application, Config } from "../types";
import { materializeAskpass } from "./askpass";
import { autodetectApplication } from "./autodetect";
import { type CloneResult, spawnClone } from "./clone";
import { emitInstalledDeps } from "./dep-metrics";
import { publishGolden, pruneGoldens, tryRestoreGolden } from "./golden-cache";
import { gitBaseArgv, gitStepEnv } from "./git-command";
import { configureGitIdentity } from "./identity";
import { denoCacheEnv, spawnInstall } from "./install";
import { spawnSetupStep } from "./spawn-step";
import { installProtectedBranchHook } from "../git/protect-branch";

const INSTALL_LOG_MAX_BYTES = 10 * 1024 * 1024;

/**
 * The named entry points into the setup pipeline. A step always runs
 * forward through the pipeline (install also runs start; clone also runs
 * install + start).
 */
export type Step = "clone" | "install" | "start";

const STEP_RANK: Record<Step, number> = { clone: 3, install: 2, start: 1 };

export interface SetupOrchestratorDeps {
  bootConfig: { appRoot: string; repoDir: string };
  store: TenantConfigStore;
  taskManager: TaskManager;
  setStatus: (next: DaemonStatus) => void;
  getStatus: () => DaemonStatus;
  broadcaster: Broadcaster;
  installState: InstallState;
  /** Workspace tmp dir; install tee lives at `<logsDir>/app/install`. */
  logsDir: string;
  lifecycle: LifecycleManager;
  branchStatus: BranchStatusMonitor;
}

/**
 * Drives the setup pipeline (clone → install → start) in response to config
 * changes (`handle(transition)`) or explicit retry requests
 * (`resumeFrom(step)`). A FIFO queue serializes runs so an in-flight install
 * can't race a branch checkout.
 */
export class SetupOrchestrator {
  private readonly queue: Step[] = [];
  private running = false;
  private currentBranchHead: string | undefined;
  private latestScripts: string[] | null = null;
  // A fresh install that hasn't been published as a golden yet — published by
  // publishPendingGolden() once the dev server is confirmed healthy. Null when
  // the boot restored an existing golden (nothing new to publish).
  private pendingGolden: { installRoot: string; pm: string } | null = null;

  constructor(private readonly deps: SetupOrchestratorDeps) {
    this.deps.taskManager.onTaskExit((summary) => {
      if (!summary.logName) return;
      if (
        !WELL_KNOWN_STARTERS.includes(
          summary.logName as (typeof WELL_KNOWN_STARTERS)[number],
        )
      )
        return;
      if (summary.intentional) return;
      if (summary.exitCode === 0 || summary.exitCode === null) return;
      const reason = `dev script exited with code ${summary.exitCode}`;
      this.chunk(`\r\n[orchestrator] ${reason}\r\n`);
      this.deps.setStatus({ state: "error", reason });
      // Lifecycle was at `starting` (post-spawn) or `running` (probe saw it
      // up briefly). Either way the dev script is gone now; surface a
      // terminal failure phase so the UI shows the retry button instead of
      // sitting on the boot animation forever. If probe later overrides to
      // `crashed`, that's also a terminal failure — both UIs treat it the
      // same.
      if (this.deps.lifecycle.current().phase !== "start-failed") {
        this.deps.lifecycle.transition({
          phase: "start-failed",
          error: reason,
        });
      }
    });
  }

  /** Studio retry endpoint → resume from a named step. Fire-and-forget. */
  resumeFrom(step: Step): void {
    // A retry is explicit intent: clear a dev-script-failure `error` so the
    // enqueued step isn't silently skipped by stepStart's status gate. `paused`
    // is deliberately left alone — that's a user stop, not a failure.
    if (this.deps.getStatus().state === "error") {
      this.deps.setStatus({ state: "running" });
    }
    this.enqueueStep(step);
  }

  /** Token rotation on an already-cloned repo — sync origin, no full clone. */
  handle(transition: Transition): void {
    if (transition.kind === "git-credential-refresh") {
      this.syncGitRemoteCredentials(transition.cloneUrl);
      return;
    }
    const step = transitionToStep(transition);
    if (!step) return;
    this.enqueueStep(step);
  }

  /** True while a step is being applied. Surfaced on /health. */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Publish the golden for this boot's fresh install — but only now that the
   * dev server is confirmed healthy (called from the probe's `running`
   * transition). Deferring here is what stops a broken install from becoming
   * a reused golden. No-op when nothing is pending (golden-restore boot, or a
   * boot with no fresh install), and self-guards against the `running`
   * transition re-firing. Fire-and-forget; best-effort.
   */
  async publishPendingGolden(): Promise<void> {
    const pending = this.pendingGolden;
    if (!pending) return;
    this.pendingGolden = null;
    const config = this.currentConfig();
    if (!config) return;
    await publishGolden({
      config,
      installRoot: pending.installRoot,
      pm: pending.pm,
      log: (m) => this.rawChunk(`${m}\r\n`),
    });
    pruneGoldens();
  }

  pendingCount(): number {
    return this.queue.length;
  }

  /** Snapshot of the most recently discovered package-manager scripts. */
  getDiscoveredScripts(): string[] | null {
    return this.latestScripts;
  }

  private enqueueStep(step: Step): void {
    // A higher-rank step subsumes lower-rank work — clone implies
    // install + start, install implies start. So if `clone` is queued,
    // there's no point also queuing `install` or `start`.
    const rank = STEP_RANK[step];
    if (this.queue.some((q) => STEP_RANK[q] >= rank)) return;
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (STEP_RANK[this.queue[i]] < rank) this.queue.splice(i, 1);
    }
    this.queue.push(step);
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const step = this.queue.shift();
        if (!step) break;
        this.chunk(`[orchestrator] running step: ${step}\r\n`);
        try {
          await this.runStep(step);
        } catch (e) {
          // Step methods own their own lifecycle transitions; this catch is
          // a backstop for unexpected throws so the queue keeps draining.
          const msg = (e as Error).message;
          this.chunk(`\r\n[orchestrator] step ${step} crashed: ${msg}\r\n`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runStep(step: Step): Promise<void> {
    switch (step) {
      case "clone":
        // A `clone` step from `branch-change` runs `git checkout -f` against
        // the live repo; the dev server has to be down before that, otherwise
        // the checkout fights an open file handle / writes its sources.
        await this.stopDevTask();
        if (!(await this.stepClone())) return;
        if (!(await this.stepInstall())) return;
        await this.stepStart();
        return;
      case "install":
        await this.stopDevTask();
        if (!(await this.stepInstall())) return;
        await this.stepStart();
        return;
      case "start":
        // stepStart owns the stop: it skips the kill entirely when an
        // identical dev is already running, so a port-change can't SIGTERM a
        // mid-boot dev only to respawn the same command.
        await this.stepStart();
        return;
    }
  }

  private currentConfig(): Config | null {
    const enriched = this.deps.store.read();
    if (!enriched) return null;
    return Object.freeze({
      ...enriched,
      daemonToken: "",
      daemonBootId: "",
      proxyPort: 0,
      appRoot: this.deps.bootConfig.appRoot,
      repoDir: this.deps.bootConfig.repoDir,
    }) as Config;
  }

  private chunk(data: string): void {
    this.deps.broadcaster.broadcastChunk("setup", data);
  }

  // Raw subprocess output (clone/install/checkout). Skips the stdout tee so
  // pod logs aren't drowned in progress bars; still goes to SSE + replay +
  // the per-step LogTee on disk.
  private rawChunk(data: string): void {
    this.deps.broadcaster.broadcastChunk("setup", data, { tee: false });
  }

  /**
   * Acquires source: clone if no .git, otherwise checkout the configured
   * branch. Then runs idempotent post-source-acquisition steps (git
   * identity, protected-branch hook, fillDefaults).
   */
  private async stepClone(): Promise<boolean> {
    const config = this.currentConfig();
    if (!config) return false;
    const cloneUrl = config.git?.repository?.cloneUrl;

    if (cloneUrl && hasGitRepo(config.repoDir)) {
      this.syncGitRemoteCredentials(cloneUrl);
    }

    if (cloneUrl && !hasGitRepo(config.repoDir)) {
      this.deps.lifecycle.transition({ phase: "cloning" });
      const cloneLogPath = appLogPath(this.deps.logsDir, "clone");
      try {
        unlinkSync(cloneLogPath);
      } catch {
        /* not present */
      }
      const cloneTee = new LogTee(cloneLogPath, INSTALL_LOG_MAX_BYTES);
      let result: CloneResult;
      try {
        const askpassPath = await materializeAskpass(this.deps.logsDir);
        result = await spawnClone({
          config,
          askpassPath,
          onChunk: (_src, data) => {
            this.rawChunk(data);
            cloneTee.write(data);
          },
        });
      } catch (e) {
        cloneTee.close();
        const error = (e as Error).message;
        this.chunk(`\r\n[orchestrator] clone failed: ${error}\r\n`);
        this.deps.lifecycle.transition({ phase: "clone-failed", error });
        return false;
      }
      cloneTee.close();
      if (result.code !== 0) {
        const error = `exit ${result.code}`;
        this.chunk(`\r\n[orchestrator] clone failed (${error})\r\n`);
        this.deps.lifecycle.transition({ phase: "clone-failed", error });
        return false;
      }
      // Base-branch fetch is off the critical path: fire it detached so
      // install+start don't wait on 1-2 network round trips that only feed
      // the divergence header. Logs via rawChunk (the clone tee is closed);
      // refreshes branch status when it lands so the header updates without
      // waiting for the next poll. Best-effort — a failure just leaves the
      // header in its "unavailable until next fetch" state.
      if (result.fetchBase) {
        void result
          .fetchBase((_src, data) => this.rawChunk(data))
          .then(() => this.deps.branchStatus.refresh())
          .catch((e) =>
            this.rawChunk(
              `\r\n[clone] deferred base fetch failed: ${(e as Error).message}\r\n`,
            ),
          );
      }
    } else if (cloneUrl) {
      // Repo exists. If a different branch is configured, treat that as a
      // checkout step under the lifecycle.
      const branch = config.git?.repository?.branch;
      if (branch && !isSyntheticBranch(branch)) {
        this.deps.lifecycle.transition({ phase: "checking-out", to: branch });
        try {
          await this.checkoutBranch(branch);
        } catch (e) {
          const error = (e as Error).message;
          this.chunk(`\r\n[orchestrator] checkout failed: ${error}\r\n`);
          this.deps.lifecycle.transition({ phase: "clone-failed", error });
          return false;
        }
      } else {
        this.chunk(`[orchestrator] repo already cloned\r\n`);
      }
    }

    // Identity has to run after clone so `git config` has a repo to write
    // into — earlier order tripped posix_spawn ENOENT (it reads cwd before
    // exec, and repoDir doesn't exist until clone returns).
    await this.gitSetup(config);
    await this.fillApplicationDefaults(config.repoDir);
    this.deps.branchStatus.refresh();
    return true;
  }

  /**
   * Run install. Skips when fingerprint matches (already installed for this
   * config + branch HEAD). Returns true on success/skip, false on failure.
   */
  private async stepInstall(): Promise<boolean> {
    const config = this.currentConfig();
    if (!config) return false;
    if (this.deps.installState.isInstalledFor(config, this.currentBranchHead)) {
      this.broadcastDiscoveredScripts(config);
      return true;
    }
    const pm = config.application?.packageManager?.name;
    if (!pm) {
      // Nothing to install — proceed to start, which will diagnose.
      return true;
    }

    this.deps.lifecycle.transition({ phase: "installing" });

    // Golden fast path: reflink a cached node_modules for this exact lockfile
    // and skip `bun install` entirely (see golden-cache.ts). Best-effort — a
    // miss or any failure falls through to the normal install below.
    const installRoot = resolvePmRoot(
      config.repoDir,
      config.application?.packageManager?.path,
    );
    if (
      await tryRestoreGolden({
        config,
        installRoot,
        pm,
        log: (m) => this.chunk(`${m}\r\n`),
      })
    ) {
      // Restored from an existing golden — nothing to publish.
      this.pendingGolden = null;
      this.markInstallSucceeded(config);
      return true;
    }

    this.chunk(`[orchestrator] installing dependencies\r\n`);

    const installLogPath = appLogPath(this.deps.logsDir, "install");
    try {
      unlinkSync(installLogPath);
    } catch {
      /* not present */
    }
    const installTee = new LogTee(installLogPath, INSTALL_LOG_MAX_BYTES);
    const installPromise = spawnInstall({
      config,
      env: config.env,
      onChunk: (_src, data) => {
        this.rawChunk(data);
        installTee.write(data);
      },
    });
    // null = no install step needed (e.g. deno auto-fetches; or no manifest
    // present yet). Treat as success so the caller proceeds to start; mark
    // the install fingerprint so resume doesn't retry on every boot.
    if (!installPromise) {
      installTee.close();
      this.markInstallSucceeded(config);
      return true;
    }
    const code = await installPromise;
    installTee.close();
    if (code !== 0) {
      const error = `exit ${code}`;
      this.chunk(`\r\n[orchestrator] install failed (${error})\r\n`);
      this.deps.installState.mark(
        InstallStateClass.fingerprint(config, this.currentBranchHead),
        false,
      );
      this.deps.lifecycle.transition({ phase: "install-failed", error });
      return false;
    }
    this.markInstallSucceeded(config);
    // Install scripts (postinstall/prepare — lefthook, husky, etc.) can
    // overwrite .git/hooks/pre-push; reinstall so branch protection survives.
    if (config.repoDir) {
      try {
        await installProtectedBranchHook(config.repoDir);
      } catch (e) {
        this.chunk(
          `\r\n[orchestrator] warning: could not reinstall protected-branch hook: ${(e as Error).message}\r\n`,
        );
      }
    }
    // Don't publish the golden yet — defer to publishPendingGolden(), which
    // the probe's `running` transition calls once the dev server is confirmed
    // healthy. Publishing only from a boot that actually came up prevents a
    // broken-but-exit-0 install from becoming a golden that every later branch
    // then reuses (the "sticky bad golden" failure mode).
    this.pendingGolden = { installRoot, pm };
    // Report the installed dep set for pre-bake analysis (best-effort, async).
    void emitInstalledDeps({
      installRoot,
      packageManager: pm,
      bootId: process.env.DAEMON_BOOT_ID ?? "",
      repoName: config.git?.repository?.repoName,
      branch: config.git?.repository?.branch,
    });
    return true;
  }

  /**
   * Spawn the dev script. Probe drives the transition from `starting` to
   * `running` once the dev server responds.
   */
  private async stepStart(): Promise<void> {
    const config = this.currentConfig();
    if (!config) return;
    if (this.deps.getStatus().state !== "running") {
      this.chunk(
        `\r\n[orchestrator] skipping start: status=${this.deps.getStatus().state} (resume to retry)\r\n`,
      );
      return;
    }
    if (
      !this.deps.installState.isInstalledFor(config, this.currentBranchHead)
    ) {
      this.chunk(
        "\r\n[orchestrator] skipping start: install fingerprint mismatch\r\n",
      );
      return;
    }
    const command = this.buildStartCommand(config);
    if (!command) {
      const reason = this.diagnoseNoStartCommand(config);
      this.chunk(reason);
      this.deps.lifecycle.transition({
        phase: "start-failed",
        error: reason.replace(/\r?\n/g, " ").trim(),
      });
      return;
    }

    const running = this.deps.taskManager.runningCommandByLogName(
      command.source,
    );
    if (running?.command === command.cmd && running?.cwd === command.cwd) {
      this.chunk(
        `[orchestrator] dev already running (${command.source}) — skipping restart\r\n`,
      );
      // The dev task we would have spawned is already up (same command+cwd),
      // but a prior failure may have left lifecycle at a terminal phase the
      // probe refuses to promote from. Reconcile: enter `starting` so the
      // probe can confirm `running` on its next healthy response. No-op when
      // the lifecycle already reflects a live server.
      // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
      const cur = this.deps.lifecycle.current().phase;
      if (cur !== "running" && cur !== "starting") {
        this.deps.lifecycle.transition({ phase: "starting" });
      }
      return;
    }
    await this.stopDevTask();
    this.deps.lifecycle.transition({ phase: "starting" });
    // denoCacheEnv points DENO_DIR at the per-repo node-local cache for deno
    // dev servers (no-op for other PMs); layered under config.env so a
    // user-supplied DENO_DIR still wins. Runtime PATH dirs are prepended
    // last, over whatever PATH falls out of that merge (a user override
    // included) rather than getting replaced by it; when the merge carries
    // no PATH, fall back to the daemon's own PATH so the prepend never
    // replaces the effective PATH outright.
    const merged = buildDevEnv(config, {
      ...denoCacheEnv(config),
      ...config.env,
    });
    await this.deps.taskManager.spawn({
      command: command.cmd,
      cwd: command.cwd,
      env: {
        ...merged,
        ...withPathDirs(config.runtimePathDirs, {
          PATH: merged.PATH ?? process.env.PATH,
        }),
      },
      label: command.label,
      mode: "pty",
      logName: command.source,
      replaceByLogName: true,
    });
  }

  /**
   * Fill missing application fields (packageManager, runtime, port) from
   * `.decocms/daemon.json` then from lockfile autodetect. Studio-supplied
   * config always wins; this only patches gaps.
   *
   * Goes through `store.applyInternal` (not `apply`) so a fresh
   * pm-change/runtime-change isn't emitted — this runs inside stepClone,
   * which already handles install+start. The `compute` callback executes
   * inside the store's serial queue, so a concurrent PUT can't race the
   * read-then-write.
   */
  private async fillApplicationDefaults(repoDir: string): Promise<void> {
    const outcome = await readConfig(repoDir);
    const diskApp =
      outcome.kind === "valid" ? outcome.config.application : undefined;

    await this.deps.store.applyInternal((current) => {
      const cur: Application = current?.application ?? {};
      // What the config "should" look like: cur > diskApp > autodetect.
      const target: Application = {
        ...autodetectApplication(repoDir, { ...diskApp, ...cur }),
        ...diskApp,
        ...cur,
      };
      // Patch only the fields cur is missing — never overwrite caller values.
      const patch: { -readonly [K in keyof Application]?: Application[K] } = {};
      if (!cur.packageManager?.name && target.packageManager) {
        patch.packageManager = target.packageManager;
      }
      if (!cur.runtime && target.runtime) {
        patch.runtime = target.runtime;
      }
      if (cur.port === undefined && target.port !== undefined) {
        patch.port = target.port;
      }
      if (Object.keys(patch).length === 0) return null;
      return { application: patch };
    });
  }

  private async stopDevTask(): Promise<void> {
    for (const starter of WELL_KNOWN_STARTERS) {
      this.deps.taskManager.killByLogName(starter, { intentional: true });
    }
    await this.deps.taskManager.waitForLogNamesIdle(WELL_KNOWN_STARTERS);
  }

  private diagnoseNoStartCommand(config: Config): string {
    const pm = config.application?.packageManager?.name;
    if (!pm) {
      return "\r\n[orchestrator] skipping start: no package manager configured — update the VM config to enable a dev server\r\n";
    }
    const pmConf = PACKAGE_MANAGER_DAEMON_CONFIG[pm];
    const cwd = resolvePmRoot(
      config.repoDir,
      config.application?.packageManager?.path,
    );
    const scripts = discoverScripts(cwd, pm);
    if (scripts.length === 0) {
      const hasManifest = pmConf?.manifests.some((f) =>
        existsSync(join(cwd, f)),
      );
      if (!hasManifest) {
        return `\r\n[orchestrator] skipping start: no package manifest (${pmConf?.manifests.join(" or ")}) found at ${cwd} — update the VM config if a dev server should run\r\n`;
      }
      return `\r\n[orchestrator] skipping start: no scripts defined in ${cwd}/package.json — update the VM config if a dev server should run\r\n`;
    }
    return `\r\n[orchestrator] skipping start: no 'dev' or 'start' script found (available: ${scripts.join(", ")}) — update the VM config to set the correct start script\r\n`;
  }

  private buildStartCommand(config: Config): {
    cmd: string;
    cwd: string;
    label: string;
    source: string;
  } | null {
    const pm = config.application?.packageManager?.name;
    if (!pm) return null;
    const pmConf = PACKAGE_MANAGER_DAEMON_CONFIG[pm];
    if (!pmConf) return null;
    const cwd = resolvePmRoot(
      config.repoDir,
      config.application?.packageManager?.path,
    );
    const scripts = discoverScripts(cwd, pm);
    const starter = WELL_KNOWN_STARTERS.find((s) => scripts.includes(s));
    if (!starter) return null;
    return {
      ...pmRunCommand(cwd, pmConf.runPrefix, starter),
      source: starter,
    };
  }

  private async gitSetup(config: Config): Promise<void> {
    try {
      configureGitIdentity(config);
    } catch (e) {
      this.chunk(
        `\r\n[orchestrator] warning: git identity setup failed: ${(e as Error).message}\r\n`,
      );
    }
    if (config.repoDir) {
      try {
        await installProtectedBranchHook(config.repoDir);
      } catch (e) {
        this.chunk(
          `\r\n[orchestrator] warning: could not install protected-branch hook: ${(e as Error).message}\r\n`,
        );
      }
      // Exclude the org-fs mount at boot, before any sync can run. The mount /
      // its `repoDir/org` symlink is daemon-managed, never repo source —
      // ensureRepoOrgLink also excludes it, but only lazily at dispatch once
      // mounts are up, so a shutdown sync that races that leaves org-fs files
      // (org/…) staged onto the user's branch. info/exclude is local-only and
      // never affects already-tracked files, so a repo that genuinely tracks
      // org/ is unharmed.
      await ensureGitExclude(config.repoDir, "/org");
    }
    const branch = config.git?.repository?.branch;
    if (branch && !isSyntheticBranch(branch)) {
      this.chunk(`[orchestrator] checking out branch: ${branch}\r\n`);
      try {
        await this.checkoutBranch(branch);
      } catch (e) {
        this.chunk(
          `\r\n[orchestrator] warning: branch checkout failed: ${(e as Error).message}\r\n`,
        );
      }
    }
    this.refreshBranchHead();
  }

  private markInstallSucceeded(config: Config): void {
    this.deps.installState.mark(
      InstallStateClass.fingerprint(config, this.currentBranchHead),
      true,
    );
    this.broadcastDiscoveredScripts(config);
  }

  // Source of truth for the SSE `scripts` event. Without this the UI never
  // opens script tabs (e.g. Dev) — the env panel gates `openScriptTabs` on
  // `vmEvents.scripts`. Idempotent: callers in both fresh-install and
  // skip-install paths dispatch the same payload.
  private broadcastDiscoveredScripts(config: Config): void {
    const cwd = resolvePmRoot(
      config.repoDir,
      config.application?.packageManager?.path,
    );
    const scripts = discoverScripts(
      cwd,
      config.application?.packageManager?.name ?? null,
    );
    this.latestScripts = scripts;
    this.deps.broadcaster.emit("scripts", { scripts });
  }

  private refreshBranchHead(): void {
    const repoDir = this.deps.bootConfig.repoDir;
    if (!repoDir) return;
    if (!hasGitRepo(repoDir)) {
      this.currentBranchHead = undefined;
      return;
    }
    try {
      this.currentBranchHead = gitSync(["rev-parse", "HEAD"], { cwd: repoDir });
    } catch {
      this.currentBranchHead = undefined;
    }
  }

  private async checkoutBranch(branch: string): Promise<void> {
    const repoDir = this.deps.bootConfig.repoDir;
    if (!repoDir) return;
    const onChunk = (_src: "setup", data: string) => this.rawChunk(data);
    const askpassPath = await materializeAskpass(this.deps.logsDir);
    const runGit = (args: readonly string[]) =>
      spawnSetupStep(
        {
          argv: [...gitBaseArgv(), ...args],
          env: gitStepEnv(askpassPath),
          cwd: repoDir,
        },
        onChunk,
      );
    await spawnCheckoutBranch({
      repoDir,
      branch,
      runGit,
      log: (message) => this.chunk(message),
    });
  }

  private syncGitRemoteCredentials(cloneUrl: string): void {
    const repoDir = this.deps.bootConfig.repoDir;
    if (!repoDir || !hasGitRepo(repoDir)) return;
    try {
      syncOriginRemote(repoDir, cloneUrl);
      this.chunk("[orchestrator] synced origin credentials\r\n");
    } catch (e) {
      const msg = (e as Error).message;
      this.chunk(
        `\r\n[orchestrator] failed to sync origin credentials: ${msg}\r\n`,
      );
    }
  }
}

function transitionToStep(t: Transition): Step | null {
  switch (t.kind) {
    case "bootstrap":
    case "branch-change":
      return "clone";
    case "runtime-change":
    case "pm-change":
      return "install";
    case "port-change":
      return "start";
    case "env-change":
    case "git-credential-refresh":
    case "identity-conflict":
    case "no-op":
      return null;
    default:
      t satisfies never;
      return null;
  }
}
