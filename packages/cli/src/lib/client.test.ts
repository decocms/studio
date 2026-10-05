import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMeshClient, createStudioClient } from "./runtime.js";
import type { StudioClientDeps } from "./runtime.js";

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
} as unknown as StudioClientDeps;

describe("createStudioClient", () => {
  beforeEach(() => {
    mockCallTool.mockClear();
    mockConnect.mockClear();
    mockClose.mockClear();
  });

  test("returns an object with callable tool methods", async () => {
    type Tools = {
      MY_TOOL: { input: { id: string }; output: { name: string } };
    };

    const client = createStudioClient<Tools>(
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

  test("keeps createMeshClient as a compatibility alias", async () => {
    type Tools = {
      MY_TOOL: { input: { id: string }; output: { name: string } };
    };
    const client = createMeshClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk_test" },
      deps,
    );

    await expect(client.MY_TOOL({ id: "123" })).resolves.toEqual({
      tool: "MY_TOOL",
      args: { id: "123" },
    });
  });

  test("throws on isError response", async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [{ text: "Tool failed: bad input" }],
    });

    type Tools = {
      FAIL_TOOL: { input: Record<string, never>; output: unknown };
    };
    const client = createStudioClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk" },
      deps,
    );

    await expect(client.FAIL_TOOL({})).rejects.toThrow(
      "Tool failed: bad input",
    );
  });

  test("throws a message naming the tool even with no text content", async () => {
    mockCallTool.mockResolvedValueOnce({
      isError: true,
      content: [],
    });

    type Tools = {
      FAIL_TOOL: { input: Record<string, never>; output: unknown };
    };
    const client = createStudioClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk" },
      deps,
    );

    await expect(client.FAIL_TOOL({})).rejects.toThrow(
      'Tool "FAIL_TOOL" failed',
    );
  });

  test("close() closes the underlying client and allows reconnect", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };
    const client = createStudioClient<Tools>(
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

  test("retries connecting after a failed connect instead of caching the rejection forever", async () => {
    mockConnect.mockRejectedValueOnce(new Error("network blip"));

    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };
    const client = createStudioClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk" },
      deps,
    );

    await expect(client.TOOL({})).rejects.toThrow("network blip");

    // Transient failure resolved — a later call should retry, not replay the
    // same cached rejection forever.
    await expect(client.TOOL({})).resolves.toEqual({
      tool: "TOOL",
      args: {},
    });
    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  test("is not treated as a thenable (await would otherwise hang forever)", () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };
    const client = createStudioClient<Tools>(
      { mcpId: "vmc_test", apiKey: "sk" },
      deps,
    );

    expect(client.then).toBeUndefined();
  });

  test("builds URL with correct mcpId and baseUrl", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const capturedUrls: URL[] = [];
    const capturingTransport = function (url: URL) {
      capturedUrls.push(url);
    };

    const client = createStudioClient<Tools>(
      {
        mcpId: "vmc_abc123",
        apiKey: "sk_key",
        baseUrl: "https://custom.example.com",
      },
      {
        ...deps,
        Transport:
          capturingTransport as unknown as StudioClientDeps["Transport"],
      },
    );

    await client.TOOL({});

    expect(capturedUrls[0]?.toString()).toBe(
      "https://custom.example.com/mcp/virtual-mcp/vmc_abc123",
    );
  });

  test("defaults baseUrl to https://studio.decocms.com", async () => {
    type Tools = { TOOL: { input: Record<string, never>; output: unknown } };

    const capturedUrls: URL[] = [];
    const capturingTransport = function (url: URL) {
      capturedUrls.push(url);
    };

    const client = createStudioClient<Tools>(
      { mcpId: "vmc_abc", apiKey: "sk" },
      {
        ...deps,
        Transport:
          capturingTransport as unknown as StudioClientDeps["Transport"],
      },
    );

    await client.TOOL({});

    expect(capturedUrls[0]?.toString()).toBe(
      "https://studio.decocms.com/mcp/virtual-mcp/vmc_abc",
    );
  });
});
