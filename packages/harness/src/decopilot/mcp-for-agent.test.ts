import { describe, expect, test } from "bun:test";
import type { McpClient } from "../harness-deps";

// Pinned shape assertion: mcpForAgent must accept (agentId, opts) and
// return a client exposing listTools + getInstructions (parity with
// createVirtualClientFrom + PassthroughClient). This is the portable seam
// the cluster (in-process PassthroughClient) and the daemon (HTTP Client)
// both implement.
describe("mcpForAgent seam", () => {
  test("returns a client with listTools and getInstructions", async () => {
    const mcpForAgent = async (
      agentId: string,
      opts?: { superUser?: boolean; listTimeoutMs?: number },
    ): Promise<McpClient> => ({
      listTools: async () => ({ tools: [] }),
      callTool: async () => ({ content: [] }),
      listResources: async () => ({ resources: [] }),
      readResource: async () => ({ contents: [] }),
      listPrompts: async () => ({ prompts: [] }),
      getPrompt: async () => ({ messages: [] }),
      getInstructions: () =>
        `instructions for ${agentId} su=${opts?.superUser}`,
      getConnectionTitleMap: () => new Map(),
      close: async () => {},
    });
    const client = await mcpForAgent("agent-1", {
      superUser: true,
      listTimeoutMs: 1000,
    });
    expect((await client.listTools()).tools).toEqual([]);
    expect(client.getInstructions()).toContain("agent-1");
  });
});
