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
import type { BranchStatusMonitor } from "../git/branch-status";
import { gitSync } from "../git/git-sync";
import type { InstallState } from "../install/install-state";
import { InstallState as InstallStateClass } from "../install/install-state";
import { LogTee } from "../process/log-tee";
import { appLogPath, hasGitRepo, resolvePmRoot } from "../paths";
import { discoverScripts } from "../process/script-discovery";
import type { PhaseManager } from "../process/phase-manager";
import type { Application, Config } from "../types";
import { autodetectApplication } from "./autodetect";
import { spawnClone } from "./clone";
import { configureGitIdentity } from "./identity";
import { spawnInstall } from "./install";
import { installProtectedBranchHook } from "../git/protect-branch";

const INSTALL_LOG_MAX_BYTES = 10 * 1024 * 1024;

export interface SetupOrchestratorDeps {
  bootConfig: { appRoot: string; repoDir: string };
  store: TenantConfigStore;
  taskManager: TaskManager;
  setIntent: (next: { state: "running" | "paused"; reason?: string }) => void;
  getIntent: () => { state: "running" | "paused"; reason?: string };
  broadcaster: Broadcaster;
  installState: InstallState;
  /** Workspace tmp dir; install tee lives at `<logsDir>/app/install`. */
  logsDir: string;
  /** When provided, setup phases are tracked via the phase manager. */
  phaseManager?: PhaseManager;
  branchStatus: BranchStatusMonitor;
}

/**
 * Reducer over `Transition` events emitted by the config store.
 *
 * Each transition maps to one async recipe. An internal FIFO queue
 * serializes runs so an in-flight install can't race a branch checkout.
 * Same-kind transitions coalesce (only the most recent matters).
 */
export class SetupOrchestrator {
  private readonly queue: Transition[] = [];
  private running = false;
  private currentBranchHead: string | undefined;

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
      this.deps.setIntent({
        state: "paused",
        reason: `dev script exited with code ${summary.exitCode}`,
      });
    });
  }

  /** Fire-and-forget enqueue. */
  handle(transition: Transition): void {
    if (
      transition.kind === "no-op" ||
      transition.kind === "identity-conflict"
    ) {
      return;
    }
    this.coalesce(transition);
    void this.drain();
  }

  /** True while a transition is being applied. Surfaced on /health. */
  isRunning(): boolean {
    return this.running;
  }

  pendingCount(): number {
    return this.queue.length;
  }

  private coalesce(t: Transition): void {
    // Last-of-kind wins for transitions that fully describe themselves.
    const collapsable = new Set([
      "branch-change",
      "pm-change",
      "runtime-change",
      "port-change",
    ]);
    if (collapsable.has(t.kind)) {
      const idx = this.queue.findIndex((q) => q.kind === t.kind);
      if (idx >= 0) this.queue.splice(idx, 1);
    }
    this.queue.push(t);
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const t = this.queue.shift();
        if (!t) break;
        const taskId = this.deps.phaseManager?.begin(`transition:${t.kind}`);
        this.chunk(`[orchestrator] transition: ${t.kind}\r\n`);
        this.deps.broadcaster.broadcastEvent("transition", {
          kind: t.kind,
          phase: "start",
        });
        try {
          await this.run(t);
          this.chunk(`[orchestrator] done: ${t.kind}\r\n`);
          this.deps.broadcaster.broadcastEvent("transition", {
            kind: t.kind,
            phase: "done",
          });
          if (taskId) this.deps.phaseManager?.done(taskId);
        } catch (e) {
          const msg = (e as Error).message;
          this.chunk(`\r\n[orchestrator] failed: ${t.kind}: ${msg}\r\n`);
          this.deps.broadcaster.broadcastEvent("transition", {
            kind: t.kind,
            phase: "failed",
            error: msg,
          });
          if (taskId) this.deps.phaseManager?.fail(taskId, msg);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async run(t: Transition): Promise<void> {
    switch (t.kind) {
      case "bootstrap":
        return this.bootstrap();
      case "branch-change":
        return this.branchChange(t.to);
      case "pm-change":
      case "runtime-change":
        return this.reinstallAndMaybeStart();
      case "port-change":
        return this.maybeRestartDev();
      case "no-op":
      case "identity-conflict":
        return;
      default:
        t satisfies never;
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

  private async bootstrap(): Promise<void> {
    const initial = this.currentConfig();
    if (!initial) return;

    const cloneUrl = initial.git?.repository?.cloneUrl;
    if (cloneUrl && !hasGitRepo(initial.repoDir)) {
      this.deps.branchStatus.setPhase({ kind: "cloning" });
      const cloneTaskId = this.deps.phaseManager?.begin("clone");
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
          config: initial,
          onChunk: (_src, data) => {
            this.chunk(data);
            cloneTee.write(data);
          },
        });
      } catch (e) {
        cloneTee.close();
        const error = (e as Error).message;
        this.chunk(`\r\n[orchestrator] clone failed: ${error}\r\n`);
        if (cloneTaskId) this.deps.phaseManager?.fail(cloneTaskId, error);
        this.deps.branchStatus.setPhase({ kind: "clone-failed", error });
        return;
      }
      cloneTee.close();
      if (code !== 0) {
        this.chunk(`\r\n[orchestrator] clone failed (exit ${code})\r\n`);
        if (cloneTaskId)
          this.deps.phaseManager?.fail(cloneTaskId, `exit ${code}`);
        this.deps.branchStatus.setPhase({
          kind: "clone-failed",
          error: `exit ${code}`,
        });
        return;
      }
      if (cloneTaskId) this.deps.phaseManager?.done(cloneTaskId);
    } else if (cloneUrl) {
      this.chunk(`[orchestrator] repo already cloned\r\n`);
    }

    // Identity has to run after clone so `git config` has a repo to write
    // into — earlier order tripped posix_spawn ENOENT (it reads cwd before
    // exec, and repoDir doesn't exist until clone returns).
    await this.gitSetup(initial);
    await this.fillApplicationDefaults(initial.repoDir);
    this.deps.branchStatus.markReady();

    const config = this.currentConfig();
    if (!config) return;

    if (
      !this.deps.installState.isInstalledFor(config, this.currentBranchHead)
    ) {
      const ok = await this.runInstall();
      if (!ok) return;
    } else {
      this.broadcastDiscoveredScripts(config);
    }
    await this.startIfReady();
  }

  /**
   * Fill missing application fields (packageManager, runtime, port) from
   * `.decocms/daemon.json` then from lockfile autodetect. Mesh-supplied
   * config always wins; this only patches gaps.
   *
   * Goes through `store.applyInternal` (not `apply`) so a fresh
   * pm-change/runtime-change isn't emitted — this runs inside bootstrap,
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

  private async branchChange(to: string): Promise<void> {
    await this.stopDevTask();
    this.chunk(`[orchestrator] checking out branch: ${to}\r\n`);
    this.deps.branchStatus.setPhase({ kind: "checking-out", to });
    try {
      await this.checkoutBranch(to);
    } catch (e) {
      const error = (e as Error).message;
      this.chunk(`\r\n[orchestrator] branch-change failed: ${error}\r\n`);
      this.deps.branchStatus.setPhase({ kind: "checkout-failed", error });
      return;
    }
    this.refreshBranchHead();
    this.deps.branchStatus.markReady();
    const ok = await this.runInstall();
    if (ok) await this.startIfReady();
  }

  private async reinstallAndMaybeStart(): Promise<void> {
    await this.stopDevTask();
    const ok = await this.runInstall();
    if (ok) await this.startIfReady();
  }

  private async maybeRestartDev(): Promise<void> {
    await this.stopDevTask();
    await this.startIfReady();
  }

  private async stopDevTask(): Promise<void> {
    for (const starter of WELL_KNOWN_STARTERS) {
      this.deps.taskManager.killByLogName(starter, { intentional: true });
    }
    await this.deps.taskManager.waitForLogNamesIdle(WELL_KNOWN_STARTERS);
  }

  /**
   * Start the dev script iff the install fingerprint matches and we have a
   * discovered starter script. No retry on failure — the dev process must be
   * (re)launched by a config change (pm, runtime, branch, or port).
   */
  private async startIfReady(): Promise<void> {
    const config = this.currentConfig();
    if (!config) return;
    if (this.deps.getIntent().state === "paused") {
      this.chunk(
        "\r\n[orchestrator] skipping start: intent=paused (resume to retry)\r\n",
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
      this.chunk(this.diagnoseNoStartCommand(config));
      return;
    }
    await this.deps.taskManager.spawn({
      command: command.cmd,
      cwd: command.cwd,
      env: buildDevEnv(config),
      label: command.label,
      mode: "pty",
      logName: command.source,
      replaceByLogName: true,
    });
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

  private async runInstall(): Promise<boolean> {
    const config = this.currentConfig();
    if (!config) return false;
    if (!config.application?.packageManager?.name) return false;
    const installTaskId = this.deps.phaseManager?.begin("install");
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
      onChunk: (_src, data) => {
        this.chunk(data);
        installTee.write(data);
      },
    });
    // null = no install step needed (e.g. deno auto-fetches; or no manifest
    // present yet). Treat as success so the caller proceeds to start; mark
    // the install fingerprint so resume doesn't retry on every boot.
    if (!installPromise) {
      installTee.close();
      this.markInstallSucceeded(config);
      if (installTaskId) this.deps.phaseManager?.done(installTaskId);
      return true;
    }
    const code = await installPromise;
    installTee.close();
    if (code !== 0) {
      this.chunk(`\r\n[orchestrator] install failed (exit ${code})\r\n`);
      this.deps.installState.mark(
        InstallStateClass.fingerprint(config, this.currentBranchHead),
        false,
      );
      if (installTaskId)
        this.deps.phaseManager?.fail(installTaskId, `exit ${code}`);
      return false;
    }
    this.markInstallSucceeded(config);
    if (installTaskId) this.deps.phaseManager?.done(installTaskId);
    return true;
  }

  private async gitSetup(config: Config): Promise<void> {
    const gitTaskId = this.deps.phaseManager?.begin("git-setup");
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
    if (gitTaskId) this.deps.phaseManager?.done(gitTaskId);
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
    this.deps.broadcaster.broadcastEvent("scripts", {
      type: "scripts",
      scripts,
    });
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

    let onRemote = false;
    try {
      gitSync(
        [
          "-c",
          "safe.directory=*",
          "fetch",
          "origin",
          `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
        ],
        { cwd: repoDir },
      );
      gitSync(
        ["-c", "safe.directory=*", "fetch", "origin", `${branch}:${branch}`],
        { cwd: repoDir },
      );
      onRemote = true;
    } catch {
      /* not on remote — fall through to local create */
    }
    if (onRemote) {
      gitSync(["-c", "safe.directory=*", "checkout", "-f", branch], {
        cwd: repoDir,
      });
    } else {
      try {
        gitSync(["-c", "safe.directory=*", "checkout", "-f", branch], {
          cwd: repoDir,
        });
      } catch {
        gitSync(["-c", "safe.directory=*", "checkout", "-b", branch], {
          cwd: repoDir,
        });
      }
    }
  }
}
