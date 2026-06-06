import { describe, expect, test } from "bun:test";
import {
  buildCancelSubject,
  buildReplySubject,
  buildRequestSubject,
  createProxyDispatch,
  type ProxyNatsAdapter,
} from "./link-proxy-routes";
import {
  encodeProxyReplyFrame,
  type ProxyReplyFrame,
} from "./link-proxy-frames";

interface Op {
  kind: "subscribe" | "publish";
  subject: string;
}

/**
 * Fake ProxyNatsAdapter that records the order of subscribe/publish calls and
 * lets a test push reply frames to whatever subject is currently subscribed.
 */
function makeFakeNats() {
  const ops: Op[] = [];
  const subs = new Map<string, (data: Uint8Array) => void>();
  const published: { subject: string; data: Uint8Array }[] = [];
  const nats: ProxyNatsAdapter = {
    publish(subject, data) {
      ops.push({ kind: "publish", subject });
      published.push({ subject, data });
    },
    subscribe(subject, onMessage) {
      ops.push({ kind: "subscribe", subject });
      subs.set(subject, onMessage);
      return () => subs.delete(subject);
    },
  };
  const enc = new TextEncoder();
  const deliver = (subject: string, frame: ProxyReplyFrame): void => {
    const cb = subs.get(subject);
    cb?.(enc.encode(encodeProxyReplyFrame(frame)));
  };
  return { nats, ops, subs, published, deliver };
}

const baseReq = {
  method: "GET",
  path: "/_sandbox/events",
  headers: {} as Record<string, string>,
};

describe("createProxyDispatch", () => {
  test("subscribes to the reply subject BEFORE publishing the request", async () => {
    const f = makeFakeNats();
    const dispatch = createProxyDispatch({ nats: f.nats });

    // Drive the iterator far enough to publish the request, delivering a
    // terminal end so it completes.
    const it = dispatch("user-1", baseReq)[Symbol.asyncIterator]();
    // The first `next()` runs up to the first await (after publish).
    const firstNext = it.next();
    // After publish, exactly one subscribe then one publish should have run.
    // The reply subject is the first subscribe; the request subject the publish.
    const subscribeOp = f.ops.find((o) => o.kind === "subscribe");
    const publishOp = f.ops.find((o) => o.kind === "publish");
    expect(subscribeOp).toBeDefined();
    expect(publishOp).toBeDefined();
    expect(f.ops.indexOf(subscribeOp!)).toBeLessThan(f.ops.indexOf(publishOp!));
    expect(subscribeOp!.subject).toMatch(/^links\.proxy\.reply\./);
    expect(publishOp!.subject).toBe(buildRequestSubject("user-1"));

    // Complete it so the generator cleans up.
    const replySubject = subscribeOp!.subject;
    f.deliver(replySubject, { type: "end" });
    await firstNext;
    await it.next();
  });

  test("yields headers then chunks until end", async () => {
    const f = makeFakeNats();
    const dispatch = createProxyDispatch({ nats: f.nats });
    const out: { data?: string; status?: number }[] = [];

    const run = (async () => {
      for await (const ev of dispatch("user-1", baseReq)) {
        out.push({ data: ev.data, status: ev.headers?.status });
      }
    })();

    // Give the generator a tick to subscribe+publish.
    await Promise.resolve();
    const replySubject = f.ops.find((o) => o.kind === "subscribe")!.subject;
    f.deliver(replySubject, { type: "headers", status: 200, headers: {} });
    f.deliver(replySubject, { type: "chunk", data: "QQ==" });
    f.deliver(replySubject, { type: "chunk", data: "Qg==" });
    f.deliver(replySubject, { type: "end" });
    await run;

    expect(out).toEqual([
      { data: undefined, status: 200 },
      { data: "QQ==", status: undefined },
      { data: "Qg==", status: undefined },
    ]);
  });

  test("throws on a terminal error frame", async () => {
    const f = makeFakeNats();
    const dispatch = createProxyDispatch({ nats: f.nats });

    const run = (async () => {
      for await (const _ev of dispatch("user-1", baseReq)) {
        /* drain */
      }
    })();
    await Promise.resolve();
    const replySubject = f.ops.find((o) => o.kind === "subscribe")!.subject;
    f.deliver(replySubject, {
      type: "error",
      code: "upstream",
      message: "boom",
    });
    await expect(run).rejects.toThrow(/upstream: boom/);
  });

  test("publishes a cancel frame on abort and stops", async () => {
    const f = makeFakeNats();
    const dispatch = createProxyDispatch({ nats: f.nats });
    const ac = new AbortController();

    const run = (async () => {
      for await (const _ev of dispatch("user-1", baseReq, {
        signal: ac.signal,
      })) {
        /* drain */
      }
    })();
    await Promise.resolve();
    const replySubject = f.ops.find((o) => o.kind === "subscribe")!.subject;
    const reqId = replySubject.slice(buildReplySubject("").length);

    ac.abort();
    await expect(run).rejects.toThrow(/aborted/);

    const cancel = f.published.find(
      (p) => p.subject === buildCancelSubject(reqId),
    );
    expect(cancel).toBeDefined();
  });

  test("throws immediately if the signal is already aborted", async () => {
    const f = makeFakeNats();
    const dispatch = createProxyDispatch({ nats: f.nats });
    const ac = new AbortController();
    ac.abort();
    const run = (async () => {
      for await (const _ev of dispatch("user-1", baseReq, {
        signal: ac.signal,
      })) {
        /* */
      }
    })();
    await expect(run).rejects.toThrow(/aborted/);
    // Nothing should have been subscribed/published.
    expect(f.ops).toEqual([]);
  });

  test("rejects an unsafe userSub before touching NATS", async () => {
    const f = makeFakeNats();
    const dispatch = createProxyDispatch({ nats: f.nats });
    const run = (async () => {
      for await (const _ev of dispatch("bad.sub", baseReq)) {
        /* */
      }
    })();
    await expect(run).rejects.toThrow(/invalid userSub/);
    expect(f.ops).toEqual([]);
  });
});

describe("subject builders", () => {
  test("derive subjects purely from ids", () => {
    expect(buildRequestSubject("u1")).toBe("links.proxy.req.u1");
    expect(buildReplySubject("r1")).toBe("links.proxy.reply.r1");
    expect(buildCancelSubject("r1")).toBe("links.proxy.cancel.r1");
  });
});
