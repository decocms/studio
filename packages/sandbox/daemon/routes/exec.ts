import type { TenantConfigStore } from "../config-store";
import {
  PACKAGE_MANAGER_DAEMON_CONFIG,
  buildDevEnv,
  pmRunCommand,
} from "../constants";
import type { TaskManager } from "../process/task-manager";
import { discoverScripts } from "../process/script-discovery";
import { jsonResponse, parseBase64JsonBody } from "./body-parser";
import { awaitTaskResponse } from "./tasks";

export type ExecMode = "await" | "background";

export interface ExecDeps {
  /** Default cwd when no packageManager.path is set. Typically `<appRoot>/repo`. */
  repoDir: string;
  store: TenantConfigStore;
  taskManager: TaskManager;
}

interface ExecBody {
  mode?: ExecMode;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/**
 * POST /_decopilot_vm/exec/<name> — run package-script `<name>` via the
 * configured package manager, as a Task. Multiple invocations of the same
 * script run concurrently (each gets its own task UUID); the daemon does
 * not coordinate or deduplicate them.
 */
export function makeExecHandler(deps: ExecDeps) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const rawName = url.pathname.slice("/_decopilot_vm/exec/".length);
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
        const parsed = await parseBase64JsonBody(req);
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

    const env = buildDevEnv(config, body.env);
    const { cmd, label } = pmRunCommand(
      config.runtimePathPrefix,
      cwd,
      pmConf.runPrefix,
      name,
    );

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
      // this name so the env-tab terminal renders the output.
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
