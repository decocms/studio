/**
 * WS uplink message handler (transport-layer spec §5.3/§5.4) — cluster side.
 *
 * `createUplinkConnection` is the pure, unit-testable per-connection frame
 * dispatcher: parse each WS message with `uplinkFrameSchema`, route `chunk` →
 * `session.onFrame` and `resume`/`hello` → `session.onResume`, and close the
 * socket with a status code on a bad frame (1002 protocol error) or a rejected
 * frame (1008 policy — P3/fence; the daemon resumes). The per-run session +
 * its publish/fence/send deps are INJECTED via `sessionFor`, so this stays a
 * unit (no NATS, no StudioContext).
 *
 * `uplinkWebSocketHandler` adapts Bun's ws lifecycle to a connection. The
 * cluster builds the real per-user connection factory (StudioContext → publish
 * to DECOPILOT_STREAMS + DB fence/cancel lookups) and registers it via
 * `registerUplinkConnectionFactory`; the Bun.serve websocket handler in
 * index.ts dispatches to this object. The socket lifecycle + the real factory
 * are integration-only (multi-pod e2e).
 */
import { type UplinkFrame, uplinkFrameSchema } from "./protocol/uplink-frames";
import type { UplinkIngestSession } from "./uplink-ingest";
import { isUplinkWsData, UPLINK_KEEPALIVE_MS } from "./uplink-ws";

export interface UplinkConnectionDeps {
  /** Resolve (creating on first use) the ingest session for a run on this
   *  connection. May be async so the factory can resolve the run's DB fence
   *  once at session creation; the session then closes over a sync fenceOk
   *  against the cached value (plus publish/send/cancelRequested). */
  sessionFor: (
    runId: string,
  ) => UplinkIngestSession | Promise<UplinkIngestSession>;
  /** Close the socket with a WS status code (the daemon reconnects + resumes). */
  close: (code: number, reason?: string) => void;
}

export interface UplinkConnection {
  onMessage(raw: string | Uint8Array | ArrayBuffer): Promise<void>;
}

export function createUplinkConnection(
  deps: UplinkConnectionDeps,
): UplinkConnection {
  return {
    async onMessage(raw): Promise<void> {
      if (typeof raw !== "string") {
        deps.close(1002, "binary frames not supported");
        return;
      }
      let frame: UplinkFrame;
      try {
        const parsed = uplinkFrameSchema.safeParse(JSON.parse(raw));
        if (!parsed.success) {
          deps.close(1002, "bad frame");
          return;
        }
        frame = parsed.data;
      } catch {
        deps.close(1002, "invalid json");
        return;
      }
      try {
        switch (frame.type) {
          case "chunk":
            await (await deps.sessionFor(frame.runId)).onFrame(frame);
            break;
          case "resume":
          case "hello":
            // `hello` carries no run; only `resume` drives a cursor. A hello
            // without a run is a no-op handshake (auth already happened at the
            // upgrade). A resume replies `accept` before any chunk.
            if (frame.type === "resume") {
              await (await deps.sessionFor(frame.runId)).onResume(frame);
            }
            break;
          default:
            // accept/ack/cancel/flow are cluster→daemon (down-channel); the
            // cluster never receives them. Ignore rather than close.
            break;
        }
      } catch (err) {
        // P3 reserved lane, fence mismatch, etc. — a policy violation. Close so
        // the daemon reconnects and resends from its outbox.
        deps.close(1008, err instanceof Error ? err.message : "frame rejected");
      }
    },
  };
}

/**
 * Build the per-connection `sessionFor` from the authenticated userSub. The
 * cluster registers this at boot (closes over DECOPILOT_STREAMS publish + the
 * global DB fence/cancel lookups). Returns null when the uplink isn't wired
 * (e.g. NATS down) so the handler closes the socket. The handler supplies
 * `close` from the live ws.
 */
export type UplinkConnectionFactory = (args: {
  userSub: string;
  send: (data: string) => void;
}) => Pick<UplinkConnectionDeps, "sessionFor"> | null;

let connectionFactory: UplinkConnectionFactory | null = null;
export function registerUplinkConnectionFactory(
  factory: UplinkConnectionFactory,
): void {
  connectionFactory = factory;
}

interface UplinkWs {
  data: unknown;
  send(data: string | Uint8Array | ArrayBuffer): void;
  ping(): void;
  close(code?: number, reason?: string): void;
}

// Per-socket runtime state, stashed on ws.data alongside the upgrade carrier.
const sockets = new WeakMap<
  object,
  {
    connection: UplinkConnection | null;
    keepalive?: ReturnType<typeof setInterval>;
  }
>();

export const uplinkWebSocketHandler = {
  open(ws: UplinkWs): void {
    if (!isUplinkWsData(ws.data)) return;
    const factoryResult = connectionFactory?.({
      userSub: ws.data.userSub,
      send: (data) => ws.send(data),
    });
    if (!factoryResult) {
      ws.close(1011, "uplink unavailable");
      return;
    }
    const connection = createUplinkConnection({
      sessionFor: factoryResult.sessionFor,
      close: (code, reason) => ws.close(code, reason),
    });
    // Keepalive ping < 350s NLB idle (spec §5.2).
    const keepalive = setInterval(() => ws.ping(), UPLINK_KEEPALIVE_MS);
    sockets.set(ws.data as object, { connection, keepalive });
  },
  message(ws: UplinkWs, message: string | Uint8Array | ArrayBuffer): void {
    if (!isUplinkWsData(ws.data)) return;
    const state = sockets.get(ws.data as object);
    void state?.connection?.onMessage(message);
  },
  close(ws: UplinkWs): void {
    if (!isUplinkWsData(ws.data)) return;
    const state = sockets.get(ws.data as object);
    if (state?.keepalive) clearInterval(state.keepalive);
    sockets.delete(ws.data as object);
  },
};
