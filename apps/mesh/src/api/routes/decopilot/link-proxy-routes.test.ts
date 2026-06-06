import { describe, expect, test } from "bun:test";
import {
  buildControlSubject,
  buildReplySubject,
  buildRequestSubject,
  createProxyDispatch,
  type ProxyNatsAdapter,
  type ProxyPresenceWatcher,
} from "./link-proxy-routes";
import {
  encodeProxyReplyFrame,
  type ProxyReplyFrame,
} from "./link-proxy-frames";
import { decodeControlFrame } from "./control-frames";

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

/**
 * Fake presence watcher mirroring `LinkClaimRegistry.watch`: fires immediately
 * with the current claim, then on every `set(...)`. `set(null)` simulates the
 * claim expiring (60 s TTL not re-armed) or being explicitly deleted — the
 * daemon-vanished signal the S5 fail-fast keys off (landmine #8).
 */
function makeFakePresence(initial: unknown = { podId: "pod-x" }) {
  let current: unknown = initial;
  const listeners = new Set<(claim: unknown) => void>();
  const watcher: ProxyPresenceWatcher = {
    watch(_userSub, listener) {
      listeners.add(listener);
      // Immediate fire with the current value (LinkClaimRegistry contract).
      listener(current);
      return () => listeners.delete(listener);
    },
  };
  const set = (claim: unknown): void => {
    current = claim;
    for (const l of [...listeners]) l(claim);
  };
  return { watcher, set, listenerCount: () => listeners.size };
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

  test("publishes a cancel_req control frame on abort and stops", async () => {
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

    // Cancel rides the control channel (links.control.<userSub>), not a
    // dedicated proxy.cancel subject (landmine #3 — the daemon is outbound-only
    // and only the control-poll is inbound).
    const cancel = f.published.find(
      (p) => p.subject === buildControlSubject("user-1"),
    );
    expect(cancel).toBeDefined();
    const frame = decodeControlFrame(new TextDecoder().decode(cancel!.data));
    expect(frame).toEqual({ type: "cancel_req", reqId });
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

describe("createProxyDispatch — daemon-vanished fail-fast (S5, landmine #8)", () => {
  test("rejects when the presence claim disappears mid-await (no idle timeout needed)", async () => {
    const f = makeFakeNats();
    const presence = makeFakePresence();
    const dispatch = createProxyDispatch({
      nats: f.nats,
      presence: presence.watcher,
    });

    const out: { data?: string; status?: number }[] = [];
    const run = (async () => {
      for await (const ev of dispatch("user-1", baseReq)) {
        out.push({ data: ev.data, status: ev.headers?.status });
      }
    })();

    // Let the generator subscribe + publish + start awaiting.
    await Promise.resolve();
    const replySubject = f.ops.find((o) => o.kind === "subscribe")!.subject;

    // First frame arrives normally — confirms we are NOT failing on inter-frame
    // gaps, only on presence loss (the request body legitimately has long gaps).
    f.deliver(replySubject, { type: "headers", status: 200, headers: {} });
    await Promise.resolve();

    // The daemon vanishes: its polls stop re-arming the claim → it expires.
    presence.set(null);

    await expect(run).rejects.toThrow(/link_unavailable/);
    // The one delivered headers frame surfaced before the fail-fast.
    expect(out).toEqual([{ data: undefined, status: 200 }]);
    // The reply subscription + presence watcher were torn down (no leak).
    expect(f.subs.has(replySubject)).toBe(false);
    expect(presence.listenerCount()).toBe(0);
  });

  test("rejects immediately + skips publish when presence is already absent", async () => {
    const f = makeFakeNats();
    const presence = makeFakePresence(null); // daemon not present
    const dispatch = createProxyDispatch({
      nats: f.nats,
      presence: presence.watcher,
    });

    const run = (async () => {
      for await (const _ev of dispatch("user-1", baseReq)) {
        /* drain */
      }
    })();

    await expect(run).rejects.toThrow(/link_unavailable/);
    // Core NATS drops a publish into an unsubscribed subject, so the adapter
    // must NOT publish the RequestFrame when the daemon is already gone.
    expect(
      f.published.find((p) => p.subject === buildRequestSubject("user-1")),
    ).toBeUndefined();
    // Watcher cleaned up.
    expect(presence.listenerCount()).toBe(0);
  });

  test("completes normally while presence stays present (no false positive)", async () => {
    const f = makeFakeNats();
    const presence = makeFakePresence();
    const dispatch = createProxyDispatch({
      nats: f.nats,
      presence: presence.watcher,
    });

    const out: { data?: string; status?: number }[] = [];
    const run = (async () => {
      for await (const ev of dispatch("user-1", baseReq)) {
        out.push({ data: ev.data, status: ev.headers?.status });
      }
    })();
    await Promise.resolve();
    const replySubject = f.ops.find((o) => o.kind === "subscribe")!.subject;
    f.deliver(replySubject, { type: "headers", status: 200, headers: {} });
    f.deliver(replySubject, { type: "chunk", data: "QQ==" });
    f.deliver(replySubject, { type: "end" });
    await run;

    expect(out).toEqual([
      { data: undefined, status: 200 },
      { data: "QQ==", status: undefined },
    ]);
    // Watcher torn down on clean completion too.
    expect(presence.listenerCount()).toBe(0);
  });

  test("a benign claim refresh (non-null) does NOT abort the request", async () => {
    const f = makeFakeNats();
    const presence = makeFakePresence({ podId: "pod-x" });
    const dispatch = createProxyDispatch({
      nats: f.nats,
      presence: presence.watcher,
    });

    const out: string[] = [];
    const run = (async () => {
      for await (const ev of dispatch("user-1", baseReq)) {
        if (ev.data) out.push(ev.data);
      }
    })();
    await Promise.resolve();
    const replySubject = f.ops.find((o) => o.kind === "subscribe")!.subject;

    // A presence put with a fresh-but-present claim (TTL re-armed by the work
    // poll) must be ignored — only `null` is the vanish signal.
    presence.set({ podId: "pod-x", connectedAt: Date.now() });
    f.deliver(replySubject, { type: "chunk", data: "QQ==" });
    f.deliver(replySubject, { type: "end" });
    await run;

    expect(out).toEqual(["QQ=="]);
  });
});

describe("subject builders", () => {
  test("derive subjects purely from ids", () => {
    expect(buildRequestSubject("u1")).toBe("links.proxy.req.u1");
    expect(buildReplySubject("r1")).toBe("links.proxy.reply.r1");
    expect(buildControlSubject("u1")).toBe("links.control.u1");
  });
});
