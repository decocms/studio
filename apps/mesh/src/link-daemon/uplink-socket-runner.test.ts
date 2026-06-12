import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOutbox, type Outbox } from "./outbox";
import { type WsLike, runUplinkSocket } from "./uplink-socket-runner";

const RUN = "run_1";
const FENCE = "fence-1";

/** A controllable fake socket: the test fires open/message/close/error. */
function fakeWs() {
  const listeners: Record<string, Array<(ev: unknown) => void>> = {};
  const sent: string[] = [];
  let closed = false;
  const ws: WsLike = {
    send: (data) => sent.push(data),
    close: () => {
      closed = true;
      fire("close", {});
    },
    addEventListener: (type, cb) => {
      (listeners[type] ??= []).push(cb as (ev: unknown) => void);
    },
  };
  const fire = (type: string, ev: unknown) => {
    for (const cb of listeners[type] ?? []) cb(ev);
  };
  return { ws, sent, fire, isClosed: () => closed };
}

function withOutbox(fn: (outbox: Outbox) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "socket-"));
    const outbox = openOutbox({ path: join(dir, "ob.sqlite") });
    try {
      await fn(outbox);
    } finally {
      outbox.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

describe("runUplinkSocket", () => {
  it(
    "on socket open sends hello{bearer}; reconnects on close until aborted",
    withOutbox(async (outbox) => {
      const sockets: ReturnType<typeof fakeWs>[] = [];
      const ac = new AbortController();
      let connectCount = 0;

      const loop = runUplinkSocket({
        runId: RUN,
        fenceToken: FENCE,
        machineId: "m1",
        outbox,
        clusterBaseUrl: "https://cluster.example",
        getAccessToken: async () => `tok-${connectCount}`,
        onCancel: () => {},
        signal: ac.signal,
        backoffMs: () => 0,
        connect: (url, bearer) => {
          connectCount++;
          expect(url).toBe("https://cluster.example/api/links/uplink");
          expect(bearer).toBe(`tok-${connectCount - 1}`);
          const f = fakeWs();
          sockets.push(f);
          // Drive the lifecycle on the next tick: open → (later) close.
          queueMicrotask(() => f.fire("open", {}));
          return f.ws;
        },
      });

      // Let the first socket open + send hello, then close it → reconnect.
      await Bun.sleep(10);
      expect(sockets).toHaveLength(1);
      const hello = JSON.parse(sockets[0]!.sent[0]!);
      expect(hello).toMatchObject({
        type: "hello",
        machineId: "m1",
        bearer: "tok-0",
      });

      sockets[0]!.fire("close", {});
      await Bun.sleep(10);
      // Reconnected with a FRESH token.
      expect(connectCount).toBe(2);

      ac.abort();
      sockets[1]!.fire("close", {});
      await loop;
    }),
  );

  it(
    "routes an inbound ack frame to the sender (truncates the acked prefix)",
    withOutbox(async (outbox) => {
      for (let s = 1; s <= 3; s++) {
        outbox.append({
          runId: RUN,
          fenceToken: FENCE,
          wireSeq: s,
          lane: 2,
          line: {
            seq: s,
            event: {
              type: "ui-message-chunk",
              chunk: { type: "text-delta", delta: "x" },
            },
          },
        });
      }
      const ac = new AbortController();
      let f!: ReturnType<typeof fakeWs>;
      const loop = runUplinkSocket({
        runId: RUN,
        fenceToken: FENCE,
        machineId: "m1",
        outbox,
        clusterBaseUrl: "https://c",
        getAccessToken: async () => "t",
        onCancel: () => {},
        signal: ac.signal,
        backoffMs: () => 0,
        connect: () => {
          f = fakeWs();
          queueMicrotask(() => f.fire("open", {}));
          return f.ws;
        },
      });
      await Bun.sleep(10);
      f.fire("message", {
        data: JSON.stringify({
          type: "ack",
          runId: RUN,
          fenceToken: FENCE,
          ackSeq: 2,
        }),
      });
      await Bun.sleep(10);
      expect(
        outbox
          .replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 })
          .map((r) => r.wireSeq),
      ).toEqual([3]);
      ac.abort();
      f.fire("close", {});
      await loop;
    }),
  );
});
