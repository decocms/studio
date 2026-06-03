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
import type { Capability } from "../links/protocol/schemas";

export interface ClusterConnectionInput {
  url: string;
  accessToken: string;
  hello: {
    previewPort: number;
    machineId: string;
    hostname?: string;
    cliVersion: string;
    capabilities: Capability[];
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

    const sendErrorFrame = (err: unknown): void => {
      const message = err instanceof Error ? err.message : String(err);
      // This boundary was previously silent, which made daemon→cluster
      // `handler_error` frames invisible in the link log. Log the code +
      // message + originating request so a `handler_error: …` surfaced in the
      // cluster (via dispatcher.ts) can be traced back to the exact handler
      // path that threw on this daemon.
      console.error(
        `[cluster-connection] handler_error reqId=${frame.reqId} method=${frame.method} path=${frame.path} name=${
          err instanceof Error ? err.name : typeof err
        } message=${message}`,
      );
      try {
        ws.send(
          encodeFrame({
            type: "error",
            reqId: frame.reqId,
            code: "handler_error",
            message,
          }),
        );
      } catch {
        // WS already closed; nothing more to do.
      }
    };

    try {
      // Reverse-proxy routes (`/_sandbox/<handle>/<...>`) go through the
      // streaming surface so the real upstream status reaches the cluster.
      // The first yielded event is always `headers`; remaining events are
      // body chunks.
      if (/^\/_sandbox\/[^/]+\//.test(frame.path)) {
        try {
          for await (const ev of input.controlHandler.handleStream(frame)) {
            if (ac.signal.aborted) break;
            if (ev.type === "headers") {
              ws.send(
                encodeFrame({
                  type: "headers",
                  reqId: frame.reqId,
                  status: ev.status,
                  headers: ev.headers,
                }),
              );
            } else {
              ws.send(
                encodeFrame({
                  type: "chunk",
                  reqId: frame.reqId,
                  data: ev.data,
                }),
              );
            }
          }
          ws.send(encodeFrame({ type: "end", reqId: frame.reqId }));
        } catch (err) {
          sendErrorFrame(err);
        }
        return;
      }

      try {
        const res = await input.controlHandler.handle(frame);
        if (res.status >= 400) {
          console.warn(
            `[cluster-connection] lifecycle ${frame.method} ${frame.path} → ${res.status}${
              res.body ? ` body=${res.body.slice(0, 200)}` : ""
            }`,
          );
        } else {
          console.log(
            `[cluster-connection] lifecycle ${frame.method} ${frame.path} → ${res.status}`,
          );
        }
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
      } catch (err) {
        sendErrorFrame(err);
      }
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
        // Reset the reconnect counter so a long-lived session that survives
        // a single blip doesn't immediately pay the maximum backoff on its
        // next reconnect. Successive failures within one reconnect cycle
        // still ramp up normally.
        attempt = 0;
        console.log(
          `[cluster-connection] ws open → ${input.url} machineId=${input.hello.machineId} previewPort=${input.hello.previewPort} capabilities=${
            input.hello.capabilities.join(",") || "(none)"
          }`,
        );
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
        } catch (err) {
          console.error(
            `[cluster-connection] failed to decode frame (${text.length} bytes): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return;
        }
        if (frame.type === "request") {
          void handleRequest(ws, frame);
        } else if (frame.type === "cancel") {
          console.log(
            `[cluster-connection] cancel reqId=${frame.reqId} active=${cancellers.has(
              frame.reqId,
            )}`,
          );
          cancellers.get(frame.reqId)?.();
        }
      });

      ws.addEventListener("close", (ev) => {
        activeWs = null;
        if (stopped) {
          console.log(
            `[cluster-connection] ws closed code=${ev.code} reason="${ev.reason}" — shutting down (no reconnect)`,
          );
          resolve({ shouldReconnect: false });
          return;
        }
        const willReconnect = shouldReconnectOnClose(ev.code);
        console.warn(
          `[cluster-connection] ws closed code=${ev.code} reason="${ev.reason}" reconnect=${willReconnect}`,
        );
        resolve({ shouldReconnect: willReconnect });
      });
      ws.addEventListener("error", (ev) => {
        // The close handler drives the reconnect decision; we log here so a
        // transient WS error (DNS, TLS, connection refused) stays visible even
        // when a close event follows immediately after.
        const detail =
          (ev as { message?: string }).message ??
          (ev as { error?: { message?: string } }).error?.message ??
          "unknown";
        console.error(`[cluster-connection] ws error: ${detail}`);
      });
    });
  };

  void (async () => {
    while (!stopped && attempt < maxAttempts) {
      const { shouldReconnect } = await runOnce();
      if (stopped || !shouldReconnect) break;
      const backoffMs = computeBackoffMs(attempt);
      console.log(
        `[cluster-connection] reconnecting in ${backoffMs}ms (attempt ${attempt})`,
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
    console.log(
      `[cluster-connection] connection loop ended (stopped=${stopped} attempt=${attempt} maxAttempts=${maxAttempts})`,
    );
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
