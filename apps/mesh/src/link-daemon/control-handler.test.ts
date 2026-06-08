import { describe, expect, test } from "bun:test";
import { createControlHandler, type StreamEvent } from "./control-handler";
import type { DesktopSandboxProvider } from "./user-desktop-provider";

function fakeProvider(
  overrides: Partial<DesktopSandboxProvider> = {},
): DesktopSandboxProvider {
  return {
    async ensureSandbox() {
      return {
        sandboxApiUrl: `http://127.0.0.1:9000`,
        previewUrl: `http://test-handle.localhost:7070`,
        port: 9000,
      };
    },
    proxyPort() {
      return 9000;
    },
    getDaemonToken() {
      return "test-token";
    },
    hasHandle() {
      return true;
    },
    recordHit() {},
    acquireDispatch() {
      return () => {};
    },
    listSandboxes() {
      return [];
    },
    async deleteSandbox() {},
    async shutdown() {},
    ...overrides,
  };
}

describe("control-handler", () => {
  test("POST /api/sandboxes ensures and returns sandboxApiUrl", async () => {
    const handler = createControlHandler({ provider: fakeProvider() });
    const res = await handler.handle({
      type: "request",
      reqId: "r",
      method: "POST",
      path: "/api/sandboxes",
      headers: {},
      body: JSON.stringify({ handle: "abc" }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!)).toEqual({
      sandboxApiUrl: "http://127.0.0.1:9000",
      previewUrl: "http://test-handle.localhost:7070",
    });
  });

  test("DELETE /api/sandboxes/<handle> tears down", async () => {
    let deletedHandle: string | null = null;
    const provider = fakeProvider({
      deleteSandbox: async (h: string) => {
        deletedHandle = h;
      },
    });
    const handler = createControlHandler({ provider });
    const res = await handler.handle({
      type: "request",
      reqId: "r",
      method: "DELETE",
      path: "/api/sandboxes/abc",
      headers: {},
    });
    expect(res.status).toBe(204);
    expect(deletedHandle as unknown as string).toBe("abc");
  });

  test("unknown path → 404", async () => {
    const handler = createControlHandler({ provider: fakeProvider() });
    const res = await handler.handle({
      type: "request",
      reqId: "r",
      method: "GET",
      path: "/nope",
      headers: {},
    });
    expect(res.status).toBe(404);
  });

  test("missing handle in POST → 400", async () => {
    const handler = createControlHandler({ provider: fakeProvider() });
    const res = await handler.handle({
      type: "request",
      reqId: "r",
      method: "POST",
      path: "/api/sandboxes",
      headers: {},
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("handleStream yields 503 headers frame when sandbox connect fails", async () => {
    const throwingFetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:51812");
    }) as unknown as typeof fetch;
    const handler = createControlHandler({
      provider: fakeProvider(),
      fetchImpl: throwingFetch,
    });

    const frames: StreamEvent[] = [];
    let bodyText = "";
    for await (const ev of handler.handleStream({
      type: "request",
      reqId: "r",
      method: "GET",
      path: "/_sandbox/test-handle/dispatch",
      headers: {},
    })) {
      frames.push(ev);
      if (ev.type === "raw-chunk") {
        bodyText += new TextDecoder().decode(ev.data);
      }
    }

    expect(frames[0]).toEqual({
      type: "headers",
      status: 503,
      headers: { "content-type": "text/plain" },
    });
    expect(frames).toHaveLength(2);
    expect(frames[1]?.type).toBe("raw-chunk");
    expect(bodyText).toContain("sandbox not reachable");
  });

  test("handleStream does NOT throw on sandbox connect failure", async () => {
    const throwingFetch = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:51812");
    }) as unknown as typeof fetch;
    const handler = createControlHandler({
      provider: fakeProvider(),
      fetchImpl: throwingFetch,
    });
    const run = (async () => {
      for await (const _ of handler.handleStream({
        type: "request",
        reqId: "r",
        method: "GET",
        path: "/_sandbox/test-handle/dispatch",
        headers: {},
      })) {
        /* drain */
      }
    })();
    await expect(run).resolves.toBeUndefined();
  });
});
