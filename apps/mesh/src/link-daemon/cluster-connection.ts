/**
 * The daemon's persistent WebSocket connection to the cluster.
 *
 * - Opens `ws(s)://<cluster>/api/links/connect` with bearer auth.
 * - Sends `hello` once open.
 * - Demultiplexes `request` / `cancel` frames into the in-process control
 *   handler (task 11). For non-streaming endpoints the response is a single
 *   `headers` + `chunk` + `end`; for `/_sandbox/<handle>/*` streaming paths we
 *   stream each raw body chunk through the WS as a `chunk` frame.
 * - Reconnects per `reconnect-backoff.ts`. Stops on `WS_CLOSE_SUPERSEDED`.
 */
import { computeBackoffMs, shouldReconnectOnClose } from "./reconnect-backoff";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "../links/dispatch-frames";
import type { ControlHandler } from "./control-handler";

export interface ClusterConnectionInput {
  url: string;
  accessToken: string;
  hello: {
    previewPort: number;
    machineId: string;
    hostname?: string;
    cliVersion: string;
    capabilities: string[];
  };
  controlHandler: ControlHandler;
  /** Cap on reconnect attempts. Default `Infinity` (retry forever). */
  maxAttempts?: number;
  /** Resolved when the daemon connects successfully at least once. */
  onConnected?: () => void;
}

export interface ClusterConnectionHandle {
  /** Trigger an orderly shutdown (no reconnect). */
  close(): Promise<void>;
  /** Resolves when the connection is permanently closed (e.g., 4001 or `close()`). */
  closed: Promise<void>;
}

export async function connectToCluster(
  input: ClusterConnectionInput,
): Promise<ClusterConnectionHandle> {
  const maxAttempts = input.maxAttempts ?? Number.POSITIVE_INFINITY;
  let attempt = 0;
  let stopped = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  let activeWs: WebSocket | null = null;

  const cancellers = new Map<string, () => void>();

  const handleRequest = async (
    ws: WebSocket,
    frame: Extract<DispatchFrame, { type: "request" }>,
  ): Promise<void> => {
    const ac = new AbortController();
    cancellers.set(frame.reqId, () => ac.abort());

    try {
      // Streaming routes: any `/_sandbox/<handle>/<...>` path.
      const isStreamingSandboxPath = /^\/_sandbox\/[^/]+\//.test(frame.path);
      if (isStreamingSandboxPath) {
        ws.send(
          encodeFrame({
            type: "headers",
            reqId: frame.reqId,
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          }),
        );
        try {
          for await (const ev of input.controlHandler.handleStream(frame)) {
            if (ac.signal.aborted) break;
            ws.send(
              encodeFrame({
                type: "chunk",
                reqId: frame.reqId,
                data: ev.data,
              }),
            );
          }
          ws.send(encodeFrame({ type: "end", reqId: frame.reqId }));
        } catch (err) {
          ws.send(
            encodeFrame({
              type: "error",
              reqId: frame.reqId,
              code: "stream_error",
              message: err instanceof Error ? err.message : String(err),
            }),
          );
        }
        return;
      }

      const res = await input.controlHandler.handle(frame);
      ws.send(
        encodeFrame({
          type: "headers",
          reqId: frame.reqId,
          status: res.status,
          headers: res.headers ?? {},
        }),
      );
      if (res.body !== undefined && res.body.length > 0) {
        ws.send(
          encodeFrame({
            type: "chunk",
            reqId: frame.reqId,
            data: res.body,
          }),
        );
      }
      ws.send(encodeFrame({ type: "end", reqId: frame.reqId }));
    } finally {
      cancellers.delete(frame.reqId);
    }
  };

  const runOnce = async (): Promise<{ shouldReconnect: boolean }> => {
    attempt += 1;
    return new Promise<{ shouldReconnect: boolean }>((resolve) => {
      const ws = new WebSocket(input.url, {
        headers: { authorization: `Bearer ${input.accessToken}` },
      } as unknown as string);
      activeWs = ws;

      ws.addEventListener("open", () => {
        ws.send(
          encodeFrame({
            type: "hello",
            previewPort: input.hello.previewPort,
            machineId: input.hello.machineId,
            ...(input.hello.hostname ? { hostname: input.hello.hostname } : {}),
            cliVersion: input.hello.cliVersion,
            capabilities: input.hello.capabilities,
          }),
        );
        input.onConnected?.();
      });

      ws.addEventListener("message", (ev) => {
        const text =
          typeof ev.data === "string"
            ? ev.data
            : new TextDecoder().decode(ev.data as ArrayBuffer);
        let frame: DispatchFrame;
        try {
          frame = decodeFrame(text);
        } catch {
          return;
        }
        if (frame.type === "request") {
          void handleRequest(ws, frame);
        } else if (frame.type === "cancel") {
          cancellers.get(frame.reqId)?.();
        }
      });

      ws.addEventListener("close", (ev) => {
        activeWs = null;
        if (stopped) {
          resolve({ shouldReconnect: false });
          return;
        }
        resolve({ shouldReconnect: shouldReconnectOnClose(ev.code) });
      });
      ws.addEventListener("error", () => {
        // close handler picks up
      });
    });
  };

  void (async () => {
    while (!stopped && attempt < maxAttempts) {
      const { shouldReconnect } = await runOnce();
      if (stopped || !shouldReconnect) break;
      await new Promise((r) => setTimeout(r, computeBackoffMs(attempt)));
    }
    resolveClosed();
  })();

  return {
    async close() {
      stopped = true;
      activeWs?.close(1000, "shutdown");
      await closed;
    },
    closed,
  };
}
