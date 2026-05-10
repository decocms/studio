import { ReplayBuffer } from "./replay";
import { sseFormat } from "./sse-format";
import type { DaemonEventMap, DaemonEventName } from "./types";

type Controller = ReadableStreamDefaultController<Uint8Array>;

export class Broadcaster {
  readonly replay: ReplayBuffer;
  private readonly clients = new Set<Controller>();

  constructor(replayBytes: number) {
    this.replay = new ReplayBuffer(replayBytes);
  }

  register(ctrl: Controller): void {
    this.clients.add(ctrl);
  }

  unregister(ctrl: Controller): void {
    this.clients.delete(ctrl);
  }

  size(): number {
    return this.clients.size;
  }

  broadcastChunk(source: string, data: string): void {
    if (!data) return;
    this.replay.append(source, data);
    // Tee to stdout so `kubectl logs` / k9s show the same output that SSE
    // subscribers see. The structured events (emit below) stay SSE-only —
    // they're machine-readable JSON and would be noise here.
    process.stdout.write(`[${source}] ${data}`);
    const bytes = sseFormat("log", JSON.stringify({ source, data }));
    this.fan(bytes);
  }

  emit<K extends DaemonEventName>(name: K, payload: DaemonEventMap[K]): void {
    const bytes = sseFormat(name, JSON.stringify(payload));
    this.fan(bytes);
  }

  private fan(bytes: Uint8Array): void {
    for (const c of this.clients) {
      try {
        c.enqueue(bytes);
      } catch {
        // Swallow — controller closed under our feet.
      }
    }
  }
}
