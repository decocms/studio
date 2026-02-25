import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMeshClient } from "./runtime.js";
import type { MeshClientDeps } from "./runtime.js";

// Build mock constructors without touching the module registry
const mockCallTool = mock(
  async ({ name, arguments: args }: { name: string; arguments: unknown }) => ({
    isError: false,
    structuredContent: { tool: name, args },
  }),
);
const mockConnect = mock(async () => {});
const mockClose = mock(async () => {});

function MockClient() {
  return { callTool: mockCallTool, connect: mockConnect, close: mockClose };
}
function MockTransport() {}

const deps = {
  Client: MockClient,
  Transport: MockTransport,
} as unknown as MeshClientDeps;

describe("createMeshClient", () => {
  beforeEach(() => {
    mockCallTool.mockClear();
    mockConnect.mockClear();
    mockClose.mockClear();
  });

  test("returns an object with callable tool methods", async () => {
    type Tools = {
      MY_TOOL: { input: { id: string }; output: { name: string } };
    };

    const client = createMeshClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk_test" },
      deps,
    );

    const result = await client.MY_TOOL({ id: "123" });

    expect(result).toEqual({ tool: "MY_TOOL", args: { id: "123" } });
    expect(mockCallTool).toHaveBeenCalledWith({
      name: "MY_TOOL",
      arguments: { id: "123" },
    });
  });

  test("lazy-connects on first call", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const client = createMeshClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk" },
      deps,
    );

    expect(mockConnect).not.toHaveBeenCalled();
    await client.TOOL({});
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  test("reuses connection on subsequent calls", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const client = createMeshClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk" },
      deps,
    );

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
    const client = createMeshClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk" },
      deps,
    );

    await expect(client.FAIL_TOOL({})).rejects.toThrow(
      "Tool failed: bad input",
    );
  });

  test("close() closes the underlying client and allows reconnect", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };
    const client = createMeshClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk" },
      deps,
    );

    await client.TOOL({});
    expect(mockConnect).toHaveBeenCalledTimes(1);

    await client.close();
    expect(mockClose).toHaveBeenCalledTimes(1);

    await client.TOOL({});
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  test("builds URL with correct mcpId and baseUrl", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const capturedUrls: URL[] = [];
    const capturingTransport = function (url: URL) {
      capturedUrls.push(url);
    };

    const client = createMeshClient<Tools>(
      {
        mcpId: "vmc_abc123",
        apiKey: "sk_key",
        baseUrl: "https://custom.example.com",
      },
      {
        ...deps,
        Transport: capturingTransport as unknown as MeshClientDeps["Transport"],
      },
    );

    await client.TOOL({});

    expect(capturedUrls[0]?.toString()).toBe(
      "https://custom.example.com/mcp/virtual-mcp/vmc_abc123",
    );
  });

  test("defaults baseUrl to https://mesh-admin.decocms.com", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const capturedUrls: URL[] = [];
    const capturingTransport = function (url: URL) {
      capturedUrls.push(url);
    };

    const client = createMeshClient<Tools>(
      { mcpId: "vmc_abc", apiKey: "sk" },
      {
        ...deps,
        Transport: capturingTransport as unknown as MeshClientDeps["Transport"],
      },
    );

    await client.TOOL({});

    expect(capturedUrls[0]?.toString()).toBe(
      "https://mesh-admin.decocms.com/mcp/virtual-mcp/vmc_abc",
    );
  });
});
