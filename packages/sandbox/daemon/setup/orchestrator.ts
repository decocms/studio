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
import { gitSync } from "../git/git-sync";
import type { InstallState } from "../install/install-state";
import { InstallState as InstallStateClass } from "../install/install-state";
import type { LifecycleManager } from "../lifecycle/manager";
import { LogTee } from "../process/log-tee";
import { appLogPath, hasGitRepo, resolvePmRoot } from "../paths";
import { discoverScripts } from "../process/script-discovery";
import type { Application, Config } from "../types";
import { autodetectApplication } from "./autodetect";
import { spawnClone } from "./clone";
import { configureGitIdentity } from "./identity";
import { spawnInstall } from "./install";
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

  /** Config-store transition → step. Fire-and-forget. */
  handle(transition: Transition): void {
    const step = transitionToStep(transition);
    if (!step) return;
    this.enqueueStep(step);
  }

  /** Studio retry endpoint → resume from a named step. Fire-and-forget. */
  resumeFrom(step: Step): void {
    this.enqueueStep(step);
  }

  /** True while a step is being applied. Surfaced on /health. */
  isRunning(): boolean {
    return this.running;
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
        await this.stopDevTask();
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

    if (cloneUrl && !hasGitRepo(config.repoDir)) {
      this.deps.lifecycle.transition({ phase: "cloning" });
      const cloneLogPath = appLogPath(this.deps.logsDir, "clone");
      try {
        unlinkSync(cloneLogPath);
      } catch {
        /* not present */
      }
      const cloneTee = new LogTee(cloneLogPath, INSTALL_LOG_MAX_BYTES);
      let code: number;
      try {
        code = await spawnClone({
          config,
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
      if (code !== 0) {
        const error = `exit ${code}`;
        this.chunk(`\r\n[orchestrator] clone failed (${error})\r\n`);
        this.deps.lifecycle.transition({ phase: "clone-failed", error });
        return false;
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
    if (!config.application?.packageManager?.name) {
      // Nothing to install — proceed to start, which will diagnose.
      return true;
    }

    this.deps.lifecycle.transition({ phase: "installing" });
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
    this.deps.lifecycle.transition({ phase: "starting" });
    await this.deps.taskManager.spawn({
      command: command.cmd,
      cwd: command.cwd,
      env: buildDevEnv(config, config.env),
      label: command.label,
      mode: "pty",
      logName: command.source,
      replaceByLogName: true,
    });
  }

  /**
   * Fill missing application fields (packageManager, runtime, port) from
   * `.decocms/daemon.json` then from lockfile autodetect. Mesh-supplied
   * config always wins; this only patches gaps.
   *
   * Goes through `store.applyInternal` (not `apply`) so a fresh
   * pm-change/runtime-change isn't emitted — this runs inside stepClone,
   * which already handles install+start. The `compute` callback executes
   * inside the store's serial queue, so a concurrent PUT can't race the
   * read-then-write.
   */
  private async fillApplicationDefaults(repoDir: string): Promise<void> {
    const outcome = readConfig(repoDir);
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

  private buildStartCommand(
    config: Config,
  ): { cmd: string; cwd: string; label: string; source: string } | null {
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
      ...pmRunCommand(config.runtimePathPrefix, cwd, pmConf.runPrefix, starter),
      cwd,
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
        installProtectedBranchHook(config.repoDir);
      } catch (e) {
        this.chunk(
          `\r\n[orchestrator] warning: could not install protected-branch hook: ${(e as Error).message}\r\n`,
        );
      }
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
    // http.connectTimeout: fail fast on DNS/TCP failures (seconds).
    // lowSpeedLimit/Time: abort if transfer rate stays below 1 B/s for 10 s.
    // GIT_TERMINAL_PROMPT=0 + GIT_ASKPASS=true: never prompt for credentials —
    // public repos work without auth, private-without-creds fail fast instead
    // of hanging on a PTY-backed prompt.
    const gc = `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true git -c safe.directory='*' -c credential.helper= -c http.connectTimeout=10 -c http.lowSpeedLimit=1 -c http.lowSpeedTime=10 -C ${repoDir}`;

    // Fresh-clone path already lands on the target branch (clone.ts uses
    // --branch when ls-remote reports it exists). Short-circuit so gitSetup
    // doesn't re-fetch what we just cloned.
    try {
      const head = gitSync(["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoDir,
      });
      if (head === branch) return;
    } catch {
      // No HEAD yet / not a repo — fall through and let the checkout fail loudly.
    }

    // ls-remote --exit-code distinguishes "absent" from "broken":
    //   0  → branch exists on origin
    //   2  → origin reachable, no matching ref
    //   *  → real failure (auth/DNS/TLS) — surface to caller
    const probe = await spawnSetupStep(
      `${gc} ls-remote --exit-code --heads origin ${branch}`,
      onChunk,
    );

    if (probe === 0) {
      const fetchCode = await spawnSetupStep(
        `${gc} fetch --depth 1 origin +refs/heads/${branch}:refs/remotes/origin/${branch}`,
        onChunk,
      );
      if (fetchCode !== 0)
        throw new Error(`git fetch origin ${branch} exited ${fetchCode}`);
      // `checkout -B` creates-or-resets, avoiding DWIM ambiguity on slash-named
      // branches in shallow clones.
      const checkoutCode = await spawnSetupStep(
        `${gc} checkout -B ${branch} refs/remotes/origin/${branch}`,
        onChunk,
      );
      if (checkoutCode !== 0)
        throw new Error(`git checkout -B ${branch} exited ${checkoutCode}`);
      return;
    }

    if (probe === 2) {
      this.chunk(
        `[orchestrator] branch '${branch}' not on remote; creating local branch from HEAD\r\n`,
      );
      const code = await spawnSetupStep(`${gc} checkout -B ${branch}`, onChunk);
      if (code !== 0)
        throw new Error(`git checkout -B ${branch} exited ${code}`);
      return;
    }

    throw new Error(`git ls-remote --heads origin ${branch} exited ${probe}`);
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
    case "identity-conflict":
    case "no-op":
      // env-change is informational. Callers POST /setup/start to restart the
      // dev script with the new values; the orchestrator does not auto-react.
      return null;
    default:
      t satisfies never;
      return null;
  }
}
