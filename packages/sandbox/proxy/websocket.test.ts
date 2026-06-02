import { describe, expect, test } from "bun:test";
import {
  createNodeWebSocketProxy,
  createNodeWebSocketProxyData,
  parseWebSocketProtocols,
} from "./websocket";

describe("parseWebSocketProtocols", () => {
  test("returns trimmed protocols from the upgrade header", () => {
    const headers = new Headers({
      "sec-websocket-protocol": " vite-hmr, vite-ping ,, ",
    });
    expect(parseWebSocketProtocols(headers)).toEqual(["vite-hmr", "vite-ping"]);
  });

  test("returns undefined when no protocols are present", () => {
    expect(parseWebSocketProtocols(new Headers())).toBeUndefined();
  });
});

describe("createNodeWebSocketProxy", () => {
  test("closes the client when the pending frame cap overflows", () => {
    const proxy = createNodeWebSocketProxy({
      maxPendingFrames: 1,
      backlogOverflowReason: "test overflow",
    });
    const closed: Array<{ code?: number; reason?: string }> = [];
    const ws = {
      data: createNodeWebSocketProxyData({
        port: 1234,
        pathQuery: "/",
        protocols: undefined,
      }),
      close(code?: number, reason?: string) {
        closed.push({ code, reason });
      },
    };

    proxy.message(ws as never, "first");
    expect(ws.data.pending).toEqual(["first"]);
    expect(closed).toEqual([]);

    proxy.message(ws as never, "second");
    expect(closed).toEqual([{ code: 1011, reason: "test overflow" }]);
  });
});
