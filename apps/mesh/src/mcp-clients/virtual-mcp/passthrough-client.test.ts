import { describe, it, expect, mock, beforeEach } from "bun:test";
import { namespaceCode } from "@decocms/mcp-utils/aggregate";
import type { ConnectionEntity } from "../../tools/connection/schema";
import type {
  VirtualMCPConnection,
  VirtualMCPEntity,
} from "../../tools/virtual/schema";

// Mock createLazyClient before importing PassthroughClient
const mockCreateLazyClient = mock(
  (_conn: any, _ctx: any, _su: boolean, _cache: any): any => {
    throw new Error("createLazyClient not configured for this test");
  },
);

mock.module("../lazy-client", () => ({
  createLazyClient: (a: any, b: any, c: any, d: any) =>
    mockCreateLazyClient(a, b, c, d),
}));

// Now import after mocking
const { PassthroughClient } = await import("./passthrough-client");

function makeConnection(
  id: string,
  title = `Connection ${id}`,
): ConnectionEntity {
  return {
    id,
    title,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    created_by: "user1",
    organization_id: "org1",
    description: null,
    icon: null,
    app_name: null,
    app_id: null,
    connection_type: "HTTP",
    connection_url: "http://localhost:3000",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    metadata: null,
    tools: null,
    bindings: null,
    status: "active",
  } as ConnectionEntity;
}

function makeVmcpConn(
  connectionId: string,
  opts?: {
    tools?: string[] | null;
    resources?: string[] | null;
    prompts?: string[] | null;
  },
): VirtualMCPConnection {
  return {
    connection_id: connectionId,
    selected_tools: opts?.tools ?? null,
    selected_resources: opts?.resources ?? null,
    selected_prompts: opts?.prompts ?? null,
  };
}

function makeVirtualMcp(
  connections: VirtualMCPConnection[],
  opts?: { instructions?: string },
): VirtualMCPEntity {
  return {
    id: "vmcp1",
    title: "Test VMCP",
    description: null,
    icon: null,
    created_at: "2025-01-01T00:00:00Z",
    updated_at: "2025-01-01T00:00:00Z",
    created_by: "user1",
    organization_id: "org1",
    status: "active",
    pinned: false,
    metadata: {
      instructions: opts?.instructions ?? null,
    },
    connections,
  };
}

function makeMockClient(
  tools: { name: string }[] = [],
  resources: { uri: string; name: string }[] = [],
  prompts: { name: string }[] = [],
) {
  return {
    listTools: mock(async () => ({
      tools: tools.map((t) => ({
        ...t,
        description: `desc-${t.name}`,
        inputSchema: { type: "object" as const },
      })),
    })),
    callTool: mock(async (params: any) => ({
      content: [{ type: "text" as const, text: `result-${params.name}` }],
    })),
    listResources: mock(async () => ({
      resources: resources.map((r) => ({
        ...r,
        mimeType: "text/plain",
      })),
    })),
    readResource: mock(async (params: any) => ({
      contents: [{ uri: params.uri, text: "content", mimeType: "text/plain" }],
    })),
    listResourceTemplates: mock(async () => ({
      resourceTemplates: [],
    })),
    listPrompts: mock(async () => ({
      prompts: prompts.map((p) => ({
        ...p,
        description: `desc-${p.name}`,
      })),
    })),
    getPrompt: mock(async (params: any) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: `prompt-${params.name}` },
        },
      ],
    })),
    getServerCapabilities: mock(() => ({})),
    getInstructions: mock(() => undefined),
    close: mock(async () => {}),
  };
}

const mockCtx = {} as any;

describe("PassthroughClient", () => {
  beforeEach(() => {
    mockCreateLazyClient.mockReset();
  });

  describe("tool namespacing", () => {
    it("prefixes tool names with the connection's namespace code", async () => {
      const connA = makeConnection("conn_aaa", "Server A");
      const connB = makeConnection("conn_bbb", "Server B");

      const clientA = makeMockClient([{ name: "search" }]);
      const clientB = makeMockClient([{ name: "query" }]);

      mockCreateLazyClient.mockImplementation((conn: any) => {
        if (conn.id === "conn_aaa") return clientA as any;
        if (conn.id === "conn_bbb") return clientB as any;
        throw new Error(`Unexpected conn: ${conn.id}`);
      });

      const pt = new PassthroughClient(
        {
          connections: [connA, connB],
          virtualMcp: makeVirtualMcp([
            makeVmcpConn("conn_aaa"),
            makeVmcpConn("conn_bbb"),
          ]),
        },
        mockCtx,
      );

      const result = await pt.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).toContain(`${namespaceCode("conn_aaa")}_search`);
      expect(names).toContain(`${namespaceCode("conn_bbb")}_query`);
    });
  });

  describe("routing", () => {
    it("callTool routes to correct upstream client with original name", async () => {
      const conn = makeConnection("conn_xyz", "XYZ");
      const client = makeMockClient([{ name: "myTool" }]);

      mockCreateLazyClient.mockReturnValue(client as any);

      const pt = new PassthroughClient(
        {
          connections: [conn],
          virtualMcp: makeVirtualMcp([makeVmcpConn("conn_xyz")]),
        },
        mockCtx,
      );

      const namespacedName = `${namespaceCode("conn_xyz")}_myTool`;
      await pt.callTool({ name: namespacedName, arguments: { q: "test" } });

      // GatewayClient strips namespace before calling upstream
      expect(client.callTool).toHaveBeenCalledWith(
        { name: "myTool", arguments: { q: "test" } },
        undefined,
        undefined,
      );
    });
  });

  describe("per-client selection", () => {
    it("empty selected_tools blocks all tools from that connection", async () => {
      const connA = makeConnection("conn_a1", "A");
      const connB = makeConnection("conn_b1", "B");

      const clientA = makeMockClient([{ name: "blocked" }]);
      const clientB = makeMockClient([{ name: "allowed" }]);

      mockCreateLazyClient.mockImplementation((conn: any) => {
        if (conn.id === "conn_a1") return clientA as any;
        if (conn.id === "conn_b1") return clientB as any;
        throw new Error(`Unexpected: ${conn.id}`);
      });

      const pt = new PassthroughClient(
        {
          connections: [connA, connB],
          virtualMcp: makeVirtualMcp([
            makeVmcpConn("conn_a1", { tools: [] }),
            makeVmcpConn("conn_b1"),
          ]),
        },
        mockCtx,
      );

      const result = await pt.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).toHaveLength(1);
      expect(names[0]).toBe(`${namespaceCode("conn_b1")}_allowed`);
    });

    it("selected_tools filters to specified tools only", async () => {
      const conn = makeConnection("conn_sel", "Sel");
      const client = makeMockClient([{ name: "keep" }, { name: "drop" }]);

      mockCreateLazyClient.mockReturnValue(client as any);

      const pt = new PassthroughClient(
        {
          connections: [conn],
          virtualMcp: makeVirtualMcp([
            makeVmcpConn("conn_sel", { tools: ["keep"] }),
          ]),
        },
        mockCtx,
      );

      const result = await pt.listTools();
      const names = result.tools.map((t) => t.name);

      expect(names).toHaveLength(1);
      expect(names[0]).toBe(`${namespaceCode("conn_sel")}_keep`);
    });
  });

  describe("getInstructions", () => {
    it("supports an ephemeral connection-scoped identity without a virtual MCP", () => {
      const conn = makeConnection("conn_ephemeral", "Orders");
      mockCreateLazyClient.mockReturnValue(makeMockClient() as any);

      const pt = new PassthroughClient(
        {
          connections: [conn],
          instructions: "Ephemeral Orders specialist",
        },
        mockCtx,
      );

      expect(pt.getInstructions()).toBe("Ephemeral Orders specialist");
      expect(pt.getConnectionTitleMap()).toEqual(
        new Map([["conn_ephemeral", "Orders"]]),
      );
    });

    it("returns instructions from virtualMcp metadata", () => {
      const conn = makeConnection("conn_ins", "Ins");
      mockCreateLazyClient.mockReturnValue(makeMockClient() as any);

      const pt = new PassthroughClient(
        {
          connections: [conn],
          virtualMcp: makeVirtualMcp([makeVmcpConn("conn_ins")], {
            instructions: "Be helpful",
          }),
        },
        mockCtx,
      );

      expect(pt.getInstructions()).toBe("Be helpful");
    });

    it("returns undefined when no instructions", () => {
      const conn = makeConnection("conn_no", "No");
      mockCreateLazyClient.mockReturnValue(makeMockClient() as any);

      const pt = new PassthroughClient(
        {
          connections: [conn],
          virtualMcp: makeVirtualMcp([makeVmcpConn("conn_no")]),
        },
        mockCtx,
      );

      expect(pt.getInstructions()).toBeUndefined();
    });

    it("appends the skills catalog block after the base instructions", () => {
      const conn = makeConnection("conn_sk", "Sk");
      mockCreateLazyClient.mockReturnValue(makeMockClient() as any);

      const pt = new PassthroughClient(
        {
          connections: [conn],
          virtualMcp: makeVirtualMcp([makeVmcpConn("conn_sk")], {
            instructions: "Be helpful",
          }),
          skillsBlock: "\n\n<available-skills>\nid\n</available-skills>",
        },
        mockCtx,
      );

      const out = pt.getInstructions();
      expect(out?.startsWith("Be helpful")).toBe(true);
      expect(out).toContain("<available-skills>");
    });

    it("serves the skills block alone (leading newlines trimmed) when there are no base instructions", () => {
      const conn = makeConnection("conn_sk2", "Sk2");
      mockCreateLazyClient.mockReturnValue(makeMockClient() as any);

      const pt = new PassthroughClient(
        {
          connections: [conn],
          virtualMcp: makeVirtualMcp([makeVmcpConn("conn_sk2")]),
          skillsBlock: "\n\n<available-skills>\nid\n</available-skills>",
        },
        mockCtx,
      );

      expect(pt.getInstructions()?.startsWith("<available-skills>")).toBe(true);
    });
  });

  describe("close", () => {
    it("closes the gateway and underlying clients", async () => {
      const conn = makeConnection("conn_cl", "CL");
      const client = makeMockClient([{ name: "t" }]);

      mockCreateLazyClient.mockReturnValue(client as any);

      const pt = new PassthroughClient(
        {
          connections: [conn],
          virtualMcp: makeVirtualMcp([makeVmcpConn("conn_cl")]),
        },
        mockCtx,
      );

      // Resolve the client by listing tools
      await pt.listTools();
      await pt.close();

      expect(client.close).toHaveBeenCalled();
    });
  });
});
