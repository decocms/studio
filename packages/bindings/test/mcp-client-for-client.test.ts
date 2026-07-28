import { describe, expect, it } from "bun:test";
import { MCPClient } from "../src/core/client/mcp";
import type { ServerClient } from "../src/core/client/mcp-client";

const fakeClient: ServerClient = {
  client: {
    callTool: (async () => ({
      content: [],
    })) as ServerClient["client"]["callTool"],
    listTools: async () => ({ tools: [] }),
  },
};

describe("MCPClient.forClient", () => {
  it("returns a callable stub instead of undefined", () => {
    const stub = MCPClient.forClient(fakeClient);

    expect(typeof stub.listTools).toBe("function");
  });
});
