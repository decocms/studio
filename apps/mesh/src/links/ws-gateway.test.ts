import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createInMemoryLinkClaimRegistry,
  type LinkClaimRegistry,
} from "./link-claim-registry";
import { registerLinksGateway, gatewayWsHandlers } from "./ws-gateway";
import {
  decodeFrame,
  encodeFrame,
  type DispatchFrame,
} from "./dispatch-frames";
import { MAX_PUBLISH_BYTES } from "../nats/payload-chunking";

function makeFakeNatsAdapter() {
  // Records subscribe/publish; doesn't deliver — that's tested in dispatch demux.
  const subs = new Map<string, (data: Uint8Array, reply?: string) => void>();
  const publishes: Array<{ subject: string; data: Uint8Array }> = [];
  return {
    subs,
    publishes,
    subscribe(subject: string, cb: (data: Uint8Array, reply?: string) => void) {
      subs.set(subject, cb);
      return () => {
        subs.delete(subject);
      };
    },
    publish(subject: string, data: Uint8Array) {
      publishes.push({ subject, data });
      const handler = subs.get(subject);
      handler?.(data);
    },
    async request() {
      return null;
    },
  };
}

let server: ReturnType<typeof Bun.serve> | null = null;
let registry: LinkClaimRegistry;

beforeEach(() => {
  registry = createInMemoryLinkClaimRegistry();
});

afterEach(() => {
  server?.stop(true);
  server = null;
});

async function startGateway(opts: {
  validateBearer: (token: string) => Promise<string | null>;
  natsAdapter?: ReturnType<typeof makeFakeNatsAdapter>;
}): Promise<{ url: string; nats: ReturnType<typeof makeFakeNatsAdapter> }> {
  const nats = opts.natsAdapter ?? makeFakeNatsAdapter();
  const app = new Hono();
  registerLinksGateway(app, {
    registry,
    nats,
    validateBearer: opts.validateBearer,
    podId: "pod-test",
    helloTimeoutMs: 500,
    refreshIntervalMs: 60_000,
  });
  server = Bun.serve({
    port: 0,
    fetch: (req, srv) =>
      app.fetch(req, { server: srv } as unknown as Record<string, unknown>),
    websocket: gatewayWsHandlers,
  });
  return { url: `ws://127.0.0.1:${server.port}/api/links/connect`, nats };
}

describe("ws-gateway auth + handshake", () => {
  test("rejects upgrade without Authorization header", async () => {
    const { url } = await startGateway({ validateBearer: async () => null });
    const ws = new WebSocket(url);
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    // Bun maps an HTTP 401 rejection to close code 1002 on the client side.
    expect(code).toBe(1002);
  });

  test("rejects invalid bearer", async () => {
    const { url } = await startGateway({ validateBearer: async () => null });
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer wrong" },
    } as unknown as string);
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    // Bun maps an HTTP 401 rejection to close code 1002 on the client side.
    expect(code).toBe(1002);
  });

  test("accepts valid bearer and waits for hello", async () => {
    const { url } = await startGateway({
      validateBearer: async (t) => (t === "good" ? "user-1" : null),
    });
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer good" },
    } as unknown as string);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve());
      ws.addEventListener("error", (e) => reject(e));
    });
    expect(await registry.get("user-1")).toBeNull(); // not claimed yet
    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m-1",
        hostname: "laptop",
        cliVersion: "1.0.0",
        capabilities: ["decopilot-sandbox"],
      }),
    );
    for (let i = 0; i < 40; i++) {
      const c = await registry.get("user-1");
      if (c) {
        expect(c.previewPort).toBe(5174);
        expect(c.podId).toBe("pod-test");
        ws.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("claim never appeared");
  });

  test("closes WS if hello times out", async () => {
    const { url } = await startGateway({
      validateBearer: async () => "user-1",
    });
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer ok" },
    } as unknown as string);
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    expect(code).toBe(1008); // policy violation (hello timeout)
  });
});

describe("ws-gateway eviction", () => {
  test("closes the prior WS with 4001 when a second daemon for the same user connects to the same pod", async () => {
    const { url } = await startGateway({
      validateBearer: async () => "user-1",
    });
    const wsA = new WebSocket(url, {
      headers: { authorization: "Bearer a" },
    } as unknown as string);
    await new Promise<void>((r) => wsA.addEventListener("open", () => r()));
    wsA.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m-A",
        cliVersion: "1.0.0",
        capabilities: [],
      }),
    );
    for (let i = 0; i < 40; i++) {
      const c = await registry.get("user-1");
      if (c?.machineId === "m-A") break;
      await new Promise((r) => setTimeout(r, 25));
    }

    const closeA = new Promise<number>((resolve) => {
      wsA.addEventListener("close", (e) => resolve(e.code));
    });

    const wsB = new WebSocket(url, {
      headers: { authorization: "Bearer b" },
    } as unknown as string);
    await new Promise<void>((r) => wsB.addEventListener("open", () => r()));
    wsB.send(
      encodeFrame({
        type: "hello",
        previewPort: 5175,
        machineId: "m-B",
        cliVersion: "1.0.0",
        capabilities: [],
      }),
    );

    const codeA = await closeA;
    expect(codeA).toBe(4001);

    // After eviction, B's claim should be the surviving entry.
    for (let i = 0; i < 40; i++) {
      const c = await registry.get("user-1");
      if (c?.machineId === "m-B") {
        expect(c.previewPort).toBe(5175);
        wsB.close();
        return;
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("B's claim never appeared after same-pod eviction");
  });

  test("closes WS with 4001 when a different pod claims the user", async () => {
    const { url } = await startGateway({
      validateBearer: async () => "user-1",
    });
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer x" },
    } as unknown as string);
    await new Promise<void>((resolve) =>
      ws.addEventListener("open", () => resolve()),
    );
    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m-1",
        cliVersion: "1.0.0",
        capabilities: [],
      }),
    );
    for (let i = 0; i < 40; i++) {
      if (await registry.get("user-1")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await registry.put("user-1", {
      podId: "pod-OTHER",
      machineId: "m-2",
      cliVersion: "1.0.0",
      previewPort: 5175,
      connectedAt: Date.now(),
      capabilities: [],
    });
    const code = await new Promise<number>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e.code));
    });
    expect(code).toBe(4001);
  });
});

describe("GET /api/links/me", () => {
  test("returns null when no claim", async () => {
    const app = new Hono();
    registerLinksGateway(app, {
      registry,
      nats: makeFakeNatsAdapter(),
      validateBearer: async () => "user-1",
      podId: "pod",
    });
    const res = await app.request("/api/links/me", {
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  test("returns claim fields when present", async () => {
    const app = new Hono();
    registerLinksGateway(app, {
      registry,
      nats: makeFakeNatsAdapter(),
      validateBearer: async () => "user-1",
      podId: "pod",
    });
    await registry.put("user-1", {
      podId: "pod",
      machineId: "m",
      cliVersion: "1.0.0",
      previewPort: 5174,
      connectedAt: 1,
      capabilities: [],
    });
    const res = await app.request("/api/links/me", {
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      machineId: "m",
      cliVersion: "1.0.0",
      previewPort: 5174,
      connectedAt: 1,
    });
  });
});

describe("ws-gateway dispatch demux", () => {
  test("forwards a request frame onto the WS and streams chunks back to a reply inbox", async () => {
    const nats = makeFakeNatsAdapter();
    const inbox = "_INBOX.test";
    const replies: Uint8Array[] = [];
    nats.subs.set(inbox, (data) => replies.push(data));

    const { url } = await startGateway({
      validateBearer: async () => "user-1",
      natsAdapter: nats,
    });

    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer x" },
    } as unknown as string);
    const incoming: DispatchFrame[] = [];
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.addEventListener("message", (e) => {
      const text = typeof e.data === "string" ? e.data : "";
      try {
        incoming.push(decodeFrame(text));
      } catch {
        /* ignore */
      }
    });

    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      }),
    );
    // Wait for the dispatch subscription to be registered.
    for (let i = 0; i < 40; i++) {
      if (nats.subs.has("links.dispatch.user-1")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(nats.subs.has("links.dispatch.user-1")).toBe(true);

    // Inject a NATS dispatch message with a reply inbox.
    const dispatchHandler = nats.subs.get("links.dispatch.user-1")!;
    const requestFrame = encodeFrame({
      type: "request",
      reqId: "r-1",
      method: "GET",
      path: "/_sandbox/runs/abc",
      headers: {},
    });
    dispatchHandler(new TextEncoder().encode(requestFrame), inbox);

    // Wait for the request frame to appear on the WS.
    for (let i = 0; i < 40; i++) {
      if (incoming.find((f) => f.type === "request")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(incoming.find((f) => f.type === "request")).toBeDefined();

    // Now stream a chunk + end back from the (fake) daemon.
    ws.send(encodeFrame({ type: "chunk", reqId: "r-1", data: "hello" }));
    ws.send(encodeFrame({ type: "end", reqId: "r-1" }));

    for (let i = 0; i < 40; i++) {
      if (replies.length >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(replies.length).toBe(2);
    const decoded = replies.map((b) =>
      decodeFrame(new TextDecoder().decode(b)),
    );
    expect(decoded[0]?.type).toBe("chunk");
    expect(decoded[1]?.type).toBe("end");
    ws.close();
  });

  test("emits an error frame to every in-flight reply inbox on WS close", async () => {
    const nats = makeFakeNatsAdapter();
    const inboxA = "_INBOX.a";
    const inboxB = "_INBOX.b";
    const repliesA: Uint8Array[] = [];
    const repliesB: Uint8Array[] = [];
    nats.subs.set(inboxA, (data) => repliesA.push(data));
    nats.subs.set(inboxB, (data) => repliesB.push(data));

    const { url } = await startGateway({
      validateBearer: async () => "user-1",
      natsAdapter: nats,
    });

    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer x" },
    } as unknown as string);
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      }),
    );
    for (let i = 0; i < 40; i++) {
      if (nats.subs.has("links.dispatch.user-1")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const dispatchHandler = nats.subs.get("links.dispatch.user-1")!;
    const enc = new TextEncoder();
    dispatchHandler(
      enc.encode(
        encodeFrame({
          type: "request",
          reqId: "r-A",
          method: "GET",
          path: "/_sandbox/x/dispatch",
          headers: {},
        }),
      ),
      inboxA,
    );
    dispatchHandler(
      enc.encode(
        encodeFrame({
          type: "request",
          reqId: "r-B",
          method: "POST",
          path: "/_sandbox/y/dispatch",
          headers: {},
        }),
      ),
      inboxB,
    );

    // Close the WS before any chunk/end arrives — the gateway should fan
    // out a synthetic error frame to both reply inboxes so dispatchers
    // don't hang.
    ws.close();

    for (let i = 0; i < 80; i++) {
      if (repliesA.length > 0 && repliesB.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(repliesA.length).toBeGreaterThanOrEqual(1);
    expect(repliesB.length).toBeGreaterThanOrEqual(1);
    const frameA = decodeFrame(new TextDecoder().decode(repliesA[0]!));
    const frameB = decodeFrame(new TextDecoder().decode(repliesB[0]!));
    expect(frameA.type).toBe("error");
    expect(frameB.type).toBe("error");
  });

  test("splits an oversized chunk frame into ordered sub-chunks that each fit", async () => {
    const nats = makeFakeNatsAdapter();
    const inbox = "_INBOX.big";
    const replies: Uint8Array[] = [];
    nats.subs.set(inbox, (data) => replies.push(data));

    const { url } = await startGateway({
      validateBearer: async () => "user-1",
      natsAdapter: nats,
    });

    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer x" },
    } as unknown as string);
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      }),
    );
    for (let i = 0; i < 40; i++) {
      if (nats.subs.has("links.dispatch.user-1")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const dispatchHandler = nats.subs.get("links.dispatch.user-1")!;
    dispatchHandler(
      new TextEncoder().encode(
        encodeFrame({
          type: "request",
          reqId: "r-1",
          method: "GET",
          path: "/_sandbox/x/read",
          headers: {},
        }),
      ),
      inbox,
    );

    // One oversized chunk whose encoded frame exceeds the NATS payload budget.
    const data = "x".repeat(MAX_PUBLISH_BYTES + 100);
    ws.send(encodeFrame({ type: "chunk", reqId: "r-1", data }));

    const chunkData = () =>
      replies
        .map((b) => decodeFrame(new TextDecoder().decode(b)))
        .filter(
          (f): f is Extract<DispatchFrame, { type: "chunk" }> =>
            f.type === "chunk",
        );
    for (let i = 0; i < 80; i++) {
      if (
        chunkData()
          .map((f) => f.data)
          .join("").length >= data.length
      ) {
        break;
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    const chunks = chunkData();
    expect(chunks.length).toBeGreaterThan(1);
    for (const b of replies) {
      expect(b.length).toBeLessThanOrEqual(MAX_PUBLISH_BYTES);
    }
    expect(chunks.every((f) => f.reqId === "r-1")).toBe(true);
    expect(chunks.map((f) => f.data).join("")).toBe(data);
    ws.close();
  });

  test("a publish that throws becomes a clean error frame (no uncaught throw)", async () => {
    const nats = makeFakeNatsAdapter();
    const inbox = "_INBOX.err";
    const replies: Uint8Array[] = [];
    nats.subs.set(inbox, (data) => replies.push(data));

    const origPublish = nats.publish.bind(nats);
    let threw = false;
    (nats as { publish: typeof nats.publish }).publish = (subject, data) => {
      let frame: DispatchFrame | null = null;
      try {
        frame = decodeFrame(new TextDecoder().decode(data));
      } catch {
        /* not a frame */
      }
      if (frame?.type === "chunk" && !threw) {
        threw = true;
        throw new Error("MAX_PAYLOAD_EXCEEDED");
      }
      origPublish(subject, data);
    };

    const { url } = await startGateway({
      validateBearer: async () => "user-1",
      natsAdapter: nats,
    });
    const ws = new WebSocket(url, {
      headers: { authorization: "Bearer x" },
    } as unknown as string);
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.send(
      encodeFrame({
        type: "hello",
        previewPort: 5174,
        machineId: "m",
        cliVersion: "1",
        capabilities: [],
      }),
    );
    for (let i = 0; i < 40; i++) {
      if (nats.subs.has("links.dispatch.user-1")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const dispatchHandler = nats.subs.get("links.dispatch.user-1")!;
    dispatchHandler(
      new TextEncoder().encode(
        encodeFrame({
          type: "request",
          reqId: "r-1",
          method: "GET",
          path: "/_sandbox/x/read",
          headers: {},
        }),
      ),
      inbox,
    );

    ws.send(encodeFrame({ type: "chunk", reqId: "r-1", data: "hello" }));

    for (let i = 0; i < 80; i++) {
      if (replies.length > 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(replies.length).toBeGreaterThanOrEqual(1);
    const frame = decodeFrame(new TextDecoder().decode(replies[0]!));
    expect(frame.type).toBe("error");
    if (frame.type === "error") {
      expect(frame.code).toBe("publish_failed");
      expect(frame.reqId).toBe("r-1");
    }
    ws.close();
  });
});
