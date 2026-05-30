import { describe, expect, test } from "bun:test";
import { createDispatcher } from "./dispatcher";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "./dispatch-frames";

function makeFakeNats() {
  const subs = new Map<string, (data: Uint8Array, reply?: string) => void>();
  return {
    subs,
    publish(subject: string, data: Uint8Array, opts?: { reply?: string }) {
      const handler = subs.get(subject);
      handler?.(data, opts?.reply);
    },
    subscribe(
      subject: string,
      cb: (data: Uint8Array, reply?: string) => void,
    ): () => void {
      subs.set(subject, cb);
      return () => subs.delete(subject);
    },
    createInbox(): string {
      return `_INBOX.${Math.random().toString(36).slice(2)}`;
    },
  };
}

describe("dispatcher", () => {
  test("yields chunks until end frame, then completes", async () => {
    const nats = makeFakeNats();

    nats.subscribe("links.dispatch.user-1", (data, reply) => {
      const req = decodeFrame(new TextDecoder().decode(data));
      expect(req.type).toBe("request");
      const enc = new TextEncoder();
      const reqId = (req as Extract<DispatchFrame, { type: "request" }>).reqId;
      const chunk1 = encodeFrame({ type: "chunk", reqId, data: "a" });
      const chunk2 = encodeFrame({ type: "chunk", reqId, data: "b" });
      const end = encodeFrame({ type: "end", reqId });
      setTimeout(() => {
        const handler = nats.subs.get(reply!);
        handler?.(enc.encode(chunk1));
        handler?.(enc.encode(chunk2));
        handler?.(enc.encode(end));
      }, 0);
    });

    const dispatch = createDispatcher({ nats, requestTimeoutMs: 5_000 });
    const out: string[] = [];
    for await (const chunk of dispatch("user-1", {
      method: "GET",
      path: "/_sandbox/x",
      headers: {},
    })) {
      if (chunk.data != null) out.push(chunk.data);
    }
    expect(out).toEqual(["a", "b"]);
  });

  test("yields a headers event before chunks", async () => {
    const nats = makeFakeNats();
    nats.subscribe("links.dispatch.user-1", (data, reply) => {
      const req = decodeFrame(new TextDecoder().decode(data));
      const reqId = (req as Extract<DispatchFrame, { type: "request" }>).reqId;
      const enc = new TextEncoder();
      const headersFrame = encodeFrame({
        type: "headers",
        reqId,
        status: 418,
        headers: { "content-type": "text/plain" },
      });
      const chunk = encodeFrame({ type: "chunk", reqId, data: "tea" });
      const end = encodeFrame({ type: "end", reqId });
      setTimeout(() => {
        const handler = nats.subs.get(reply!);
        handler?.(enc.encode(headersFrame));
        handler?.(enc.encode(chunk));
        handler?.(enc.encode(end));
      }, 0);
    });
    const dispatch = createDispatcher({ nats, requestTimeoutMs: 5_000 });
    let status: number | null = null;
    let body = "";
    for await (const ev of dispatch("user-1", {
      method: "GET",
      path: "/x",
      headers: {},
    })) {
      if (ev.headers) status = ev.headers.status;
      else if (ev.data != null) body += ev.data;
    }
    expect(status).toBe(418);
    expect(body).toBe("tea");
  });

  test("throws when an error frame arrives", async () => {
    const nats = makeFakeNats();
    nats.subscribe("links.dispatch.user-1", (data, reply) => {
      const req = decodeFrame(new TextDecoder().decode(data));
      const reqId = (req as Extract<DispatchFrame, { type: "request" }>).reqId;
      const enc = new TextEncoder();
      const errFrame = encodeFrame({
        type: "error",
        reqId,
        code: "BOOM",
        message: "kaboom",
      });
      setTimeout(() => {
        const handler = nats.subs.get(reply!);
        handler?.(enc.encode(errFrame));
      }, 0);
    });
    const dispatch = createDispatcher({ nats, requestTimeoutMs: 5_000 });
    await expect(async () => {
      for await (const _ of dispatch("user-1", {
        method: "GET",
        path: "/x",
        headers: {},
      }));
    }).toThrow(/kaboom/);
  });

  test("times out if no reply arrives", async () => {
    const nats = makeFakeNats();
    // No subscriber for links.dispatch.user-1.
    const dispatch = createDispatcher({ nats, requestTimeoutMs: 100 });
    await expect(async () => {
      for await (const _ of dispatch("user-1", {
        method: "GET",
        path: "/x",
        headers: {},
      }));
    }).toThrow(/timeout/i);
  });

  test("publishes cancel on caller abort", async () => {
    const nats = makeFakeNats();
    const cancels: Array<{ subject: string; data: Uint8Array }> = [];
    const origPublish = nats.publish.bind(nats);
    (nats as { publish: typeof nats.publish }).publish = (
      subject,
      data,
      opts,
    ) => {
      if (subject === "links.cancel.user-1") cancels.push({ subject, data });
      origPublish(subject, data, opts);
    };
    // Subscribe but never reply so the iterator hangs until aborted.
    nats.subscribe("links.dispatch.user-1", () => {});
    const dispatch = createDispatcher({ nats, requestTimeoutMs: 5_000 });
    const ac = new AbortController();
    const iter = dispatch(
      "user-1",
      { method: "GET", path: "/x", headers: {} },
      { signal: ac.signal },
    );
    const next = (async () => {
      for await (const _ of iter);
    })();
    setTimeout(() => ac.abort(), 50);
    await expect(next).rejects.toThrow();
    expect(cancels.length).toBeGreaterThanOrEqual(1);
    const decoded = decodeFrame(new TextDecoder().decode(cancels[0]!.data));
    expect(decoded.type).toBe("cancel");
  });
});
