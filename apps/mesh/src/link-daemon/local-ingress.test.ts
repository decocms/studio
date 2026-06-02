import { afterEach, describe, expect, test } from "bun:test";
import { startLocalIngress, type LocalIngress } from "./local-ingress";

let ingress: LocalIngress | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
afterEach(async () => {
  await ingress?.stop();
  upstream?.stop(true);
  ingress = null;
  upstream = null;
});

describe("local-ingress HTTP proxying", () => {
  test("routes <handle>.localhost to the sandbox port", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req) {
        return new Response(`hello from ${new URL(req.url).pathname}`, {
          status: 200,
        });
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: (handle) =>
        handle === "abc" ? (upstream!.port ?? null) : null,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/widget`, {
      headers: { host: `abc.localhost:${ingress.port}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello from /widget");
  });

  test("unknown handle → 404", async () => {
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => null,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
      headers: { host: `nope.localhost:${ingress.port}` },
    });
    expect(res.status).toBe(404);
  });

  test("non-localhost host → 404", async () => {
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => 1,
    });
    const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
      headers: { host: `evil.example.com:${ingress.port}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("local-ingress WS proxying", () => {
  test("forwards WebSocket frames in both directions", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: {
        message(ws, msg) {
          ws.send(`echo:${typeof msg === "string" ? msg : ""}`);
        },
        open() {},
        close() {},
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`);
    const got: string[] = [];
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.addEventListener("message", (e) => {
      got.push(typeof e.data === "string" ? e.data : "");
    });
    ws.send("hi");
    for (let i = 0; i < 40 && got.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(got[0]).toBe("echo:hi");
    ws.close();
  });

  test("forwards path and query string to upstream", async () => {
    let seenPath: string | null = null;
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          const u = new URL(req.url);
          seenPath = `${u.pathname}${u.search}`;
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: { message() {}, open() {}, close() {} },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(
      `ws://abc.localhost:${ingress.port}/foo?token=hello`,
    );
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    // Give upstream a tick to process its own upgrade and record the path.
    for (let i = 0; i < 40 && seenPath === null; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(seenPath).toBe("/foo?token=hello");
    ws.close();
  });

  test("forwards subprotocol to upstream", async () => {
    let seenProtocol: string | null = null;
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          seenProtocol = req.headers.get("sec-websocket-protocol");
          // Bun's srv.upgrade accepts a `headers` option for the response.
          srv.upgrade(req, {
            data: {},
            headers: { "sec-websocket-protocol": "vite-hmr" },
          });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: { message() {}, open() {}, close() {} },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`, "vite-hmr");
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    for (let i = 0; i < 40 && seenProtocol === null; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(seenProtocol).toBe("vite-hmr");
    ws.close();
  });

  test("forwards binary frames in both directions", async () => {
    const received: Array<{ from: "upstream"; data: ArrayBuffer }> = [];
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: {
        message(ws, msg) {
          // Echo back as binary regardless of input shape.
          if (typeof msg === "string") {
            ws.send(new TextEncoder().encode(`echo:${msg}`));
          } else {
            // Prepend a marker byte 0xff so the round-trip is observable.
            const buf = msg instanceof ArrayBuffer ? new Uint8Array(msg) : msg;
            const out = new Uint8Array(buf.length + 1);
            out[0] = 0xff;
            out.set(buf, 1);
            ws.send(out);
          }
        },
        open() {},
        close() {},
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((r) => ws.addEventListener("open", () => r()));
    ws.addEventListener("message", (e) => {
      if (e.data instanceof ArrayBuffer) {
        received.push({ from: "upstream", data: e.data });
      }
    });
    // Send a binary frame containing bytes 0x01 0x02 0x03.
    ws.send(new Uint8Array([0x01, 0x02, 0x03]));
    for (let i = 0; i < 40 && received.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(received.length).toBe(1);
    const bytes = new Uint8Array(received[0].data);
    // Expected: [0xff, 0x01, 0x02, 0x03] — marker + original payload.
    expect(Array.from(bytes)).toEqual([0xff, 0x01, 0x02, 0x03]);
    ws.close();
  });

  test("propagates upstream close code and reason to client", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (req.headers.get("upgrade") === "websocket") {
          srv.upgrade(req, { data: {} });
          return undefined;
        }
        return new Response("no", { status: 404 });
      },
      websocket: {
        open(ws) {
          // Close with a distinctive code/reason as soon as the WS opens.
          ws.close(4321, "deliberate test close");
        },
        message() {},
        close() {},
      },
    });
    ingress = await startLocalIngress({
      port: 0,
      lookupSandboxPort: () => upstream!.port ?? null,
    });
    const ws = new WebSocket(`ws://abc.localhost:${ingress.port}/`);
    const closeEvent = await new Promise<CloseEvent>((resolve) => {
      ws.addEventListener("close", (e) => resolve(e));
    });
    expect(closeEvent.code).toBe(4321);
    expect(closeEvent.reason).toBe("deliberate test close");
  });
});
