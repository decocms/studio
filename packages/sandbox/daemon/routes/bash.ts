import type { TaskManager } from "../process/task-manager";
import { jsonResponse, parseBase64JsonBody } from "./body-parser";
import { awaitTaskResponse } from "./tasks";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 15 * 60 * 1000;

export type BashMode = "await" | "background";

export interface BashDeps {
  /** Default cwd for unscoped commands. Typically `<appRoot>/repo` (the repo). */
  repoDir: string;
  taskManager: TaskManager;
  env?: Record<string, string>;
}

interface BashBody {
  command?: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
  mode?: BashMode;
}

/**
 * Modes:
 *   - "await" (default): runs to completion and returns the full
 *     stdout/stderr/exitCode body. This is the legacy bash behavior.
 *   - "background": returns the taskId immediately. Caller can poll
 *     /_decopilot_vm/tasks/:id, stream output, or kill via the tasks API.
 */
export function makeBashHandler(deps: BashDeps) {
  return async (req: Request): Promise<Response> => {
    let body: BashBody;
    try {
      body = (await parseBase64JsonBody(req)) as BashBody;
    } catch (e) {
      return jsonResponse({ error: (e as Error).message }, 400);
    }
    if (!body.command || typeof body.command !== "string") {
      return jsonResponse({ error: "command is required" }, 400);
    }

    const mode: BashMode = body.mode === "background" ? "background" : "await";
    const timeout = clampTimeout(body.timeout, mode);
    const env = body.env ? { ...(deps.env ?? {}), ...body.env } : deps.env;

    const task = await deps.taskManager.spawn({
      command: body.command,
      cwd: body.cwd ?? deps.repoDir,
      env,
      mode: "pipe",
      timeoutMs: timeout,
      label: `$ ${body.command}`,
    });

    if (mode === "background") {
      return jsonResponse({ taskId: task.id, status: task.status });
    }

    return awaitTaskResponse(deps.taskManager, task.id, {
      timedOutExitCode: -1,
    });
  };
}

function clampTimeout(raw: number | undefined, mode: BashMode): number {
  const fallback = DEFAULT_TIMEOUT_MS;
  const requested = typeof raw === "number" && raw > 0 ? raw : fallback;
  // Background tasks may run longer; cap at 15 min (matches TaskManager TTL).
  const ceiling = mode === "background" ? MAX_TIMEOUT_MS : 120_000;
  return Math.min(requested, ceiling);
}
