import type { Broadcaster } from "./broadcast";
import { sseFormat } from "./sse-format";
import type {
  ActiveTaskSummary,
  BranchMeta,
  DaemonEventMap,
  DaemonEventName,
  DaemonStatus,
  LifecycleState,
} from "./types";

export interface SseHandshakeDeps {
  broadcaster: Broadcaster;
  getLifecycle: () => LifecycleState;
  getDiscoveredScripts: () => string[] | null;
  getActiveTasks: () => ActiveTaskSummary[];
  getStatus: () => DaemonStatus;
  getBranchMeta: () => BranchMeta;
  maxClients: number;
}

const HEARTBEAT_INTERVAL_MS = 15_000;

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

  function frame<K extends DaemonEventName>(
    name: K,
    payload: DaemonEventMap[K],
  ): Uint8Array {
    return sseFormat(name, JSON.stringify(payload));
  }

  return new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;

      c.enqueue(frame("lifecycle", { state: deps.getLifecycle() }));

      for (const src of deps.broadcaster.replay.sources()) {
        const buf = deps.broadcaster.replay.read(src);
        if (buf) {
          c.enqueue(
            sseFormat("log", JSON.stringify({ source: src, data: buf })),
          );
        }
      }

      const scripts = deps.getDiscoveredScripts();
      if (scripts) c.enqueue(frame("scripts", { scripts }));

      c.enqueue(frame("tasks", { active: deps.getActiveTasks() }));
      c.enqueue(frame("status", deps.getStatus()));
      c.enqueue(frame("branch", { meta: deps.getBranchMeta() }));

      deps.broadcaster.register(controller);

      keepAlive = setInterval(() => {
        try {
          c.enqueue(frame("lifecycle", { state: deps.getLifecycle() }));
        } catch {
          if (keepAlive) clearInterval(keepAlive);
          deps.broadcaster.unregister(controller);
        }
      }, HEARTBEAT_INTERVAL_MS);
    },

    cancel() {
      if (keepAlive) clearInterval(keepAlive);
      deps.broadcaster.unregister(controller);
    },
  });
}
