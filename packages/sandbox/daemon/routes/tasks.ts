import type { TaskManager, TaskStatus } from "../process/task-manager";
import { sseFormat } from "../events/sse-format";
import { jsonResponse } from "./body-parser";

export async function awaitTaskResponse(
  taskManager: TaskManager,
  id: string,
  opts: { extra?: Record<string, unknown>; timedOutExitCode?: number } = {},
): Promise<Response> {
  const wait = taskManager.finished(id);
  if (!wait)
    return jsonResponse({ error: "task vanished before completion" }, 500);
  const result = await wait;
  const out = taskManager.output(id);
  const exitCode =
    opts.timedOutExitCode !== undefined && result.timedOut
      ? opts.timedOutExitCode
      : result.exitCode;
  return jsonResponse({
    ...opts.extra,
    stdout: out?.stdout ?? "",
    stderr: out?.stderr ?? "",
    exitCode,
    timedOut: result.timedOut,
    truncated: out?.truncated ?? false,
  });
}

export interface TasksDeps {
  taskManager: TaskManager;
}

const VALID_STATUS: ReadonlySet<TaskStatus> = new Set([
  "running",
  "exited",
  "failed",
  "killed",
  "timeout",
]);

/** GET /_decopilot_vm/tasks?status=running,exited */
export function makeTasksListHandler(deps: TasksDeps) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const statusParam = url.searchParams.get("status");
    const status = statusParam
      ? statusParam
          .split(",")
          .filter((s): s is TaskStatus => VALID_STATUS.has(s as TaskStatus))
      : undefined;
    const tasks = deps.taskManager.list(
      status && status.length > 0 ? { status } : undefined,
    );
    return jsonResponse({ tasks });
  };
}

/** GET /_decopilot_vm/tasks/:id */
export function makeTasksGetHandler(deps: TasksDeps) {
  return async (req: Request): Promise<Response> => {
    const id = idFrom(req, "/tasks/");
    if (!id) return jsonResponse({ error: "missing task id" }, 400);
    const summary = deps.taskManager.get(id);
    if (!summary) return jsonResponse({ error: "task not found" }, 404);
    const out = deps.taskManager.output(id);
    return jsonResponse({
      ...summary,
      stdout: out?.stdout ?? "",
      stderr: out?.stderr ?? "",
      truncated: out?.truncated ?? false,
    });
  };
}

/** POST /_decopilot_vm/tasks/:id/kill[?signal=SIGTERM|SIGKILL] */
export function makeTasksKillHandler(deps: TasksDeps) {
  return async (req: Request): Promise<Response> => {
    const id = idFrom(req, "/tasks/", "/kill");
    if (!id) return jsonResponse({ error: "missing task id" }, 400);
    const url = new URL(req.url);
    const sig = (url.searchParams.get("signal") ?? "SIGTERM") as NodeJS.Signals;
    const ok = deps.taskManager.kill(id, sig);
    if (!ok) return jsonResponse({ error: "task not running" }, 400);
    return jsonResponse({ ok: true });
  };
}

/** POST /_decopilot_vm/tasks/kill-all */
export function makeTasksKillAllHandler(deps: TasksDeps) {
  return async (): Promise<Response> => {
    const count = deps.taskManager.killAll();
    return jsonResponse({ ok: true, killed: count });
  };
}

/** DELETE /_decopilot_vm/tasks/:id */
export function makeTasksDeleteHandler(deps: TasksDeps) {
  return async (req: Request): Promise<Response> => {
    const id = idFrom(req, "/tasks/");
    if (!id) return jsonResponse({ error: "missing task id" }, 400);
    const ok = deps.taskManager.delete(id);
    if (!ok)
      return jsonResponse({ error: "task not found or still running" }, 400);
    return jsonResponse({ ok: true });
  };
}

/** GET /_decopilot_vm/tasks/:id/stream — SSE: replay buffered output, then live. */
export function makeTasksStreamHandler(deps: TasksDeps) {
  return async (req: Request): Promise<Response> => {
    const id = idFrom(req, "/tasks/", "/stream");
    if (!id) return jsonResponse({ error: "missing task id" }, 400);
    const summary = deps.taskManager.get(id);
    if (!summary) return jsonResponse({ error: "task not found" }, 404);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (event: string, payload: unknown) => {
          try {
            controller.enqueue(sseFormat(event, JSON.stringify(payload)));
          } catch {
            /* controller closed */
          }
        };

        const replay = deps.taskManager.output(id);
        if (replay) {
          if (replay.stdout) send("stdout", { data: replay.stdout });
          if (replay.stderr) send("stderr", { data: replay.stderr });
        }
        if (summary.status !== "running") {
          send("end", {
            status: summary.status,
            exitCode: summary.exitCode,
            timedOut: summary.timedOut,
          });
          controller.close();
          return;
        }

        const unsubscribe = deps.taskManager.subscribe(id, (chunk) => {
          send(chunk.stream, { data: chunk.data });
        });

        void deps.taskManager.finished(id)?.then((result) => {
          send("end", {
            status: result.status,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
          });
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });

        req.signal.addEventListener("abort", () => {
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        });
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "X-Accel-Buffering": "no",
      },
    });
  };
}

function idFrom(req: Request, prefix: string, suffix?: string): string | null {
  const url = new URL(req.url);
  const tail = url.pathname.split(prefix)[1];
  if (!tail) return null;
  let id = tail;
  if (suffix && id.endsWith(suffix)) {
    id = id.slice(0, -suffix.length);
  }
  if (!id || id.includes("/")) return null;
  return id;
}
