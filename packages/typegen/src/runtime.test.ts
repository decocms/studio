import { describe, test, expect, mock, beforeEach } from "bun:test";

// Mock the MCP SDK before importing runtime
const mockCallTool = mock(
  async ({
    name,
    arguments: args,
  }: {
    name: string;
    arguments: unknown;
  }) => ({
    isError: false,
    structuredContent: { tool: name, args },
  }),
);

const mockConnect = mock(async () => {});

const MockClient = mock(function () {
  return { callTool: mockCallTool, connect: mockConnect };
});

const MockTransport = mock(function () {});

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: MockClient,
}));

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockTransport,
}));

// Import AFTER mocking
const { createMeshClient } = await import("./runtime.js");

describe("createMeshClient", () => {
  beforeEach(() => {
    mockCallTool.mockClear();
    mockConnect.mockClear();
    MockClient.mockClear();
    MockTransport.mockClear();
  });

  test("returns an object with callable tool methods", async () => {
    type Tools = {
      MY_TOOL: { input: { id: string }; output: { name: string } };
    };

    const client = createMeshClient<Tools>({
      mcpId: "vmc_test",
      apiKey: "sk_test",
    });

    const result = await client.MY_TOOL({ id: "123" });

    expect(result).toEqual({ tool: "MY_TOOL", args: { id: "123" } });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "MY_TOOL",
      arguments: { id: "123" },
    });
  });

  test("lazy-connects on first call", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const client = createMeshClient<Tools>({ mcpId: "vmc_test", apiKey: "sk" });

    expect(mockConnect).not.toHaveBeenCalled();

    await client.TOOL({});

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test("reuses connection on subsequent calls", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const client = createMeshClient<Tools>({ mcpId: "vmc_test", apiKey: "sk" });

    await client.TOOL({});
    await client.TOOL({});
    await client.TOOL({});

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test("throws on isError response", async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{ text: "Tool failed: bad input" }],
    });

    type Tools = {
      FAIL_TOOL: { input: Record<string, never>; output: unknown };
    };
    const client = createMeshClient<Tools>({ mcpId: "vmc_test", apiKey: "sk" });

    await expect(client.FAIL_TOOL({})).rejects.toThrow("Tool failed: bad input");
  });

  test("builds URL with correct mcpId and baseUrl", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    createMeshClient<Tools>({
      mcpId: "vmc_abc123",
      apiKey: "sk_key",
      baseUrl: "https://custom.example.com",
    });

    // Transport is constructed lazily, so call a tool to trigger connect
    const client = createMeshClient<Tools>({
      mcpId: "vmc_abc123",
      apiKey: "sk_key",
      baseUrl: "https://custom.example.com",
    });

    await client.TOOL({});

    const transportArg = MockTransport.mock.calls[0][0] as URL;
    expect(transportArg.toString()).toBe(
      "https://custom.example.com/mcp/virtual-mcp/vmc_abc123",
    );
  });

  test("defaults baseUrl to https://mesh-admin.decocms.com", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };
    const client = createMeshClient<Tools>({ mcpId: "vmc_abc", apiKey: "sk" });

    await client.TOOL({});

    const transportArg = MockTransport.mock.calls[0][0] as URL;
    expect(transportArg.toString()).toBe(
      "https://mesh-admin.decocms.com/mcp/virtual-mcp/vmc_abc",
    );
  });
});
