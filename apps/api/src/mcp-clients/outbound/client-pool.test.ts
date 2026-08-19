import { describe, expect, it } from "bun:test";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createClientPool } from "./client-pool";

/** A fake transport that answers the MCP `initialize` handshake so `Client.connect()` resolves. */
function createFakeTransport(): Transport {
  let onMessage: ((msg: JSONRPCMessage) => void) | undefined;
  return {
    async start() {},
    async send(msg: JSONRPCMessage) {
      if ("method" in msg && msg.method === "initialize" && "id" in msg) {
        onMessage?.({
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            serverInfo: { name: "fake", version: "1.0" },
          },
        });
      }
    },
    async close() {},
    set onmessage(fn: ((msg: JSONRPCMessage) => void) | undefined) {
      onMessage = fn;
    },
    get onmessage() {
      return onMessage;
    },
    onerror: undefined,
    onclose: undefined,
  };
}

describe("createClientPool", () => {
  it("does not invoke createTransport again on a cache hit", async () => {
    const pool = createClientPool();
    let calls = 0;
    const createTransport = () => {
      calls++;
      return createFakeTransport();
    };

    const first = await pool(createTransport, "conn_1");
    const second = await pool(createTransport, "conn_1");

    expect(first).toBe(second);
    expect(calls).toBe(1);

    await pool[Symbol.asyncDispose]();
  });

  it("invokes createTransport separately per key", async () => {
    const pool = createClientPool();
    let calls = 0;
    const createTransport = () => {
      calls++;
      return createFakeTransport();
    };

    await pool(createTransport, "conn_1");
    await pool(createTransport, "conn_2");

    expect(calls).toBe(2);

    await pool[Symbol.asyncDispose]();
  });
});
