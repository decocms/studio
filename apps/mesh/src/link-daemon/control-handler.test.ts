import { describe, expect, test } from "bun:test";
import { createControlHandler } from "./control-handler";
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
});
