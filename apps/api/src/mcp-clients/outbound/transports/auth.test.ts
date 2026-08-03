import { describe, expect, test } from "bun:test";
import { MCP_LIST_TOOLS_TIMEOUT_MS } from "@/core/constants";
import { AuthTransport } from "./auth";

describe("AuthTransport", () => {
  test(
    "bounds the internal tools/list probe instead of hanging forever when the downstream server never replies",
    async () => {
      // Simulates a downstream MCP server that accepts the request but never
      // sends a response — no onmessage callback is ever invoked.
      const hangingInner = {
        send: async () => {},
        close: async () => {},
      } as any;

      const ctx = { pendingRevalidations: [], auth: {} } as any;
      const connection = { id: "conn_test" } as any;

      const transport = new AuthTransport(hangingInner, { ctx, connection });

      const outcome = await Promise.race([
        transport
          .send({
            jsonrpc: "2.0",
            id: "1",
            method: "tools/call",
            params: { name: "SOME_TOOL", arguments: {} },
          } as any)
          .then(() => "resolved")
          .catch(() => "rejected"),
        new Promise((resolve) =>
          setTimeout(
            () => resolve("still-hanging"),
            MCP_LIST_TOOLS_TIMEOUT_MS + 3000,
          ),
        ),
      ]);

      expect(outcome).not.toBe("still-hanging");
    },
    MCP_LIST_TOOLS_TIMEOUT_MS + 5000,
  );
});
