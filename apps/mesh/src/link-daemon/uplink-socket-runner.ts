/**
 * Daemon-side WS uplink socket runner (spec §5.2) — the integration shell that
 * bridges the pure `createUplinkSender` state machine to a real WebSocket, with
 * reconnect-with-fresh-bearer (the "Expected 101" token-pin fix: a fresh
 * getAccessToken() per (re)connect, never the pinned startup token).
 *
 * The socket is INJECTED via `connect`, so the bridge (open→start, message→
 * onFrame, close→reconnect) is unit-testable with a fake; production passes a
 * `new WebSocket(url, { headers: { authorization } })` factory. The reconnect
 * loop runs until `signal` aborts. Each (re)connect mints a fresh sender so the
 * outbox cursor resumes from the last ack.
 */
import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import { uplinkFrameSchema } from "../links/protocol/uplink-frames";
import type { Outbox } from "./outbox";
import { createUplinkSender } from "./uplink-sender";

/** The slice of the WebSocket API the runner uses (injectable for tests). */
export interface WsLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    cb: (ev: { data?: unknown }) => void,
  ): void;
}

const UPLINK_PATH = "/api/links/uplink";
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

export interface UplinkSocketRunnerDeps {
  runId: string;
  fenceToken: string;
  machineId: string;
  outbox: Outbox;
  clusterBaseUrl: string;
  /** Fresh bearer per (re)connect. */
  getAccessToken: () => Promise<string>;
  /** Abort the local run on a down-channel cancel. */
  onCancel: () => void;
  /** Open a socket to `url` authenticated with `bearer`. */
  connect: (url: string, bearer: string) => WsLike;
  signal?: AbortSignal;
  /** Backoff override (tests pass `() => 0`). */
  backoffMs?: (attempt: number) => number;
}

export async function runUplinkSocket(
  deps: UplinkSocketRunnerDeps,
): Promise<void> {
  const url = `${deps.clusterBaseUrl}${UPLINK_PATH}`;
  const backoff =
    deps.backoffMs ??
    ((attempt: number) =>
      exponentialBackoffWithJitter(
        BACKOFF_CAP_MS,
        BACKOFF_BASE_MS,
        attempt,
        2,
        0.5,
      ));

  let attempt = 0;
  while (!deps.signal?.aborted) {
    // ONE fresh bearer per (re)connect — used for BOTH the upgrade auth (header)
    // and the hello frame, so they always agree.
    const bearer = await deps.getAccessToken();
    const ws = deps.connect(url, bearer);
    const sender = createUplinkSender({
      runId: deps.runId,
      fenceToken: deps.fenceToken,
      machineId: deps.machineId,
      outbox: deps.outbox,
      getAccessToken: async () => bearer,
      send: (frame) => ws.send(JSON.stringify(frame)),
      onCancel: deps.onCancel,
    });

    const closed = new Promise<void>((resolve) => {
      let done = false;
      const end = () => {
        if (done) return;
        done = true;
        resolve();
      };
      ws.addEventListener("open", () => {
        void sender.start();
      });
      ws.addEventListener("message", (ev) => {
        try {
          const parsed = uplinkFrameSchema.safeParse(
            JSON.parse(String(ev.data)),
          );
          if (parsed.success) void sender.onFrame(parsed.data);
        } catch {
          // ignore a malformed down-channel frame; the cluster owns framing.
        }
      });
      ws.addEventListener("close", end);
      ws.addEventListener("error", end);
    });

    const onAbort = () => ws.close(1000, "daemon shutting down");
    deps.signal?.addEventListener("abort", onAbort, { once: true });
    await closed;
    deps.signal?.removeEventListener("abort", onAbort);

    if (deps.signal?.aborted) break;
    // Reconnect with a fresh bearer after backoff; the sender's start() resumes
    // from the outbox's unacked tail.
    await sleep(backoff(attempt++), { signal: deps.signal }).catch(() => {});
  }
}
