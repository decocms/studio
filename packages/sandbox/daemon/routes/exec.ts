import type { TenantConfigStore } from "../config-store";
import {
  PACKAGE_MANAGER_DAEMON_CONFIG,
  WELL_KNOWN_STARTERS,
  buildDevEnv,
  pmRunCommand,
} from "../constants";
import type { DaemonStatus } from "../events/types";
import type { LifecycleManager } from "../lifecycle/manager";
import type { TaskManager } from "../process/task-manager";
import { discoverScripts } from "../process/script-discovery";
import { withPathDirs } from "../process/structured-command";
import { jsonResponse, parseJsonBody } from "./body-parser";
import { awaitTaskResponse } from "./tasks";

export type ExecMode = "await" | "background";

export interface ExecDeps {
  /** Default cwd when no packageManager.path is set. Typically `<appRoot>/repo`. */
  repoDir: string;
  store: TenantConfigStore;
  taskManager: TaskManager;
  /** Lifecycle/status reconciliation when the exec'd script is a dev starter. */
  lifecycle: LifecycleManager;
  getStatus: () => DaemonStatus;
  setStatus: (next: DaemonStatus) => void;
}

interface ExecBody {
  mode?: ExecMode;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * POST /_sandbox/exec/<name> — run package-script `<name>` via the
 * configured package manager, as a Task. Multiple invocations of the same
 * script run concurrently (each gets its own task UUID); the daemon does
 * not coordinate or deduplicate them.
 *
 * Dual-serve compat (T11): also accepts the legacy `/_decopilot_vm/exec/<name>`
 * prefix. Parsing keys off the `/exec/` segment regardless of which prefix
 * the cluster used, so adding the legacy match in entry.ts is enough — no
 * branching needed here.
 */
export function makeExecHandler(deps: ExecDeps) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const execIdx = url.pathname.indexOf("/exec/");
    const rawName =
      execIdx >= 0 ? url.pathname.slice(execIdx + "/exec/".length) : "";
    if (!rawName) return jsonResponse({ error: "missing script name" }, 400);
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      return jsonResponse({ error: "invalid script name" }, 400);
    }

    const config = deps.store.read();
    const pmName = config?.application?.packageManager?.name;
    if (!pmName) {
      return jsonResponse(
        { error: "no application configured; POST /config first" },
        409,
      );
    }
    const pmConf = PACKAGE_MANAGER_DAEMON_CONFIG[pmName];
    if (!pmConf) {
      return jsonResponse({ error: `unknown package manager: ${pmName}` }, 500);
    }

    const cwd = config.application?.packageManager?.path ?? deps.repoDir;
    const scripts = discoverScripts(cwd, pmName);
    if (!scripts.includes(name)) {
      return jsonResponse(
        {
          error: `script "${name}" not found in package file`,
          available: scripts,
        },
        404,
      );
    }

    let body: ExecBody = {};
    if (req.body) {
      try {
        const parsed = await parseJsonBody(req);
        if (parsed && typeof parsed === "object") {
          body = parsed as ExecBody;
        }
      } catch {
        /* exec accepts an empty body — treat parse error as "no overrides" */
      }
    }
    // Exec defaults to background — package scripts can be long-running
    // (`npm run dev` via /exec/dev is the obvious case). Callers that want
    // a blocking response opt in via mode: "await".
    const mode: ExecMode = body.mode === "await" ? "await" : "background";

    const { cmd, label } = pmRunCommand(
      cwd,
      pmConf.runPrefix,
      name,
      config.runtimePathDirs,
    );
    // Runtime PATH dirs must win the PATH key specifically, but merge
    // *after* config.env/body.env so a user-supplied PATH gets prepended to
    // (not replaced) rather than the whole runtime PATH being clobbered by
    // it — mirrors the old shell chain's `export PATH=/opt/bun/bin:$PATH`.
    const merged = buildDevEnv(config, { ...config.env, ...body.env });
    const env = {
      ...merged,
      ...withPathDirs(config.runtimePathDirs, merged),
    };

    // Manually running a dev starter is explicit intent to (re)start the dev
    // server — the same WELL_KNOWN_STARTERS list whose non-zero exit wedges
    // status=error / lifecycle=start-failed must also unwedge them, or the
    // daemon can never report healthy again (the probe refuses to promote
    // from terminal phases, and stepStart skips while status=error). Only
    // failure-ish states are touched: a mid-pipeline phase (cloning/
    // installing/starting) or a live `running` is left alone, and `paused`
    // (user stop) is respected.
    if ((WELL_KNOWN_STARTERS as readonly string[]).includes(name)) {
      if (deps.getStatus().state === "error") {
        deps.setStatus({ state: "running" });
      }
      const phase = deps.lifecycle.current().phase;
      // Deliberately narrower than stepStart's reconciliation (which also
      // covers clone-failed/install-failed): a manual dev exec can't repair a
      // broken clone/install — those wedges have their own resumeFrom retry
      // endpoints, and pretending `starting` there would lie to the probe.
      if (phase === "idle" || phase === "start-failed" || phase === "crashed") {
        deps.lifecycle.transition({ phase: "starting" });
      }
    }

    const task = await deps.taskManager.spawn({
      command: cmd,
      cwd,
      env,
      mode: "pty",
      timeoutMs: body.timeoutMs,
      label,
      // Named tee: <logsDir>/app/<scriptName> stays stable across runs
      // so the LLM can `cat tmp/app/build` etc. without chasing task IDs.
      // TaskManager mirrors chunks onto the global SSE log stream under
      // this name so the Preview drawer's xterm tab renders the output.
      logName: name,
    });

    if (mode === "background") {
      return jsonResponse({ taskId: task.id, status: task.status });
    }

    return awaitTaskResponse(deps.taskManager, task.id, {
      extra: { taskId: task.id },
    });
  };
}
