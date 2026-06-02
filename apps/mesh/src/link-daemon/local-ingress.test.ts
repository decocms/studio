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
});
