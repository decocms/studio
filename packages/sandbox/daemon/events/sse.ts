import type { UpstreamStatus } from "../probe";
import type { BranchStatus } from "../types";
import type { Broadcaster } from "./broadcast";
import { sseFormat } from "./sse-format";

export interface SseHandshakeDeps {
  broadcaster: Broadcaster;
  getLastStatus: () => {
    status: UpstreamStatus;
    port: number | null;
    htmlSupport: boolean;
  };
  getDiscoveredScripts: () => string[] | null;
  getActiveTasks: () => Array<{
    id: string;
    command: string;
    logName?: string;
  }>;
  getIntent: () => { state: "running" | "paused"; reason?: string };
  getLastBranchStatus: () => BranchStatus;
  maxClients: number;
}

/**
 * Returns a fresh `ReadableStream<Uint8Array>` that, on start, flushes
 * replay + current snapshots in order, then registers the controller
 * for live broadcasts.
 */
export function makeSseStream(
  deps: SseHandshakeDeps,
): ReadableStream<Uint8Array> | null {
  if (deps.broadcaster.size() >= deps.maxClients) return null;

  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let keepAlive: ReturnType<typeof setInterval> | null = null;

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;

      const last = deps.getLastStatus();
      c.enqueue(
        sseFormat("status", JSON.stringify({ type: "status", ...last })),
      );

      for (const src of deps.broadcaster.replay.sources()) {
        const buf = deps.broadcaster.replay.read(src);
        if (buf) {
          c.enqueue(
            sseFormat("log", JSON.stringify({ source: src, data: buf })),
          );
        }
      }

      const scripts = deps.getDiscoveredScripts();
      if (scripts) {
        c.enqueue(
          sseFormat("scripts", JSON.stringify({ type: "scripts", scripts })),
        );
      }

      c.enqueue(
        sseFormat(
          "tasks",
          JSON.stringify({
            type: "tasks",
            active: deps.getActiveTasks(),
          }),
        ),
      );

      c.enqueue(
        sseFormat(
          "intent",
          JSON.stringify({ type: "intent", ...deps.getIntent() }),
        ),
      );

      const lastBranch = deps.getLastBranchStatus();
      c.enqueue(
        sseFormat(
          "branch-status",
          JSON.stringify({ type: "branch-status", ...lastBranch }),
        ),
      );

      deps.broadcaster.register(controller);

      keepAlive = setInterval(() => {
        try {
          c.enqueue(
            sseFormat(
              "status",
              JSON.stringify({ type: "status", ...deps.getLastStatus() }),
            ),
          );
        } catch {
          if (keepAlive) clearInterval(keepAlive);
          deps.broadcaster.unregister(controller);
        }
      }, 15000);
    },

    cancel() {
      if (keepAlive) clearInterval(keepAlive);
      deps.broadcaster.unregister(controller);
    },
  });
}
