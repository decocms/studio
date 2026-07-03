import { describe, it, expect, mock } from "bun:test";
import type { IClient } from "../client-like.ts";
import {
  GatewayClient,
  displayToolName,
  namespaceCode,
  slugify,
  stripToolNamespace,
} from "./gateway-client.ts";

// Namespaced tool name for a client key, mirroring GatewayClient's scheme.
const ns = (key: string, tool: string) => `${namespaceCode(key)}_${tool}`;

function createMockClient(
  tools: { name: string }[] = [],
  resources: { uri: string; name: string }[] = [],
  prompts: { name: string }[] = [],
): IClient {
  return {
    listTools: mock(async () => ({
      tools: tools.map((t) => ({
        ...t,
        description: `desc-${t.name}`,
        inputSchema: { type: "object" as const },
      })),
    })),
    callTool: mock(async (params) => ({
      content: [{ type: "text" as const, text: `result-from-${params.name}` }],
    })),
    listResources: mock(async () => ({
      resources: resources.map((r) => ({
        ...r,
        mimeType: "text/plain",
      })),
    })),
    readResource: mock(async (params) => ({
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
    getPrompt: mock(async (params) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `prompt-${params.name}`,
          },
        },
      ],
    })),
    getServerCapabilities: mock(() => ({
      tools: {},
      resources: {},
      prompts: {},
    })),
    getInstructions: mock(() => undefined),
    close: mock(async () => {}),
  };
}

describe("slugify", () => {
  it("lowercases and replaces non-alphanumeric with hyphens", () => {
    expect(slugify("My Server")).toBe("my-server");
    expect(slugify("Salesforce CRM")).toBe("salesforce-crm");
    expect(slugify("a--b__c")).toBe("a-b-c");
    expect(slugify("---leading-trailing---")).toBe("leading-trailing");
    expect(slugify("simple")).toBe("simple");
  });
});

describe("stripToolNamespace", () => {
  it("strips clientId prefix", () => {
    expect(stripToolNamespace(ns("my-conn", "SOME_TOOL"), "my-conn")).toBe(
      "SOME_TOOL",
    );
  });

  it("returns unchanged when no clientId", () => {
    expect(stripToolNamespace("SOME_TOOL")).toBe("SOME_TOOL");
  });

  it("returns unchanged when clientId does not match", () => {
    expect(stripToolNamespace("other_SOME_TOOL", "my-conn")).toBe(
      "other_SOME_TOOL",
    );
  });

  it("strips real connection ID prefix", () => {
    const cid = "conn-dvitqc2ooobdzmrd5ky24";
    expect(stripToolNamespace(ns(cid, "hello_world"), cid)).toBe("hello_world");
  });
});

describe("displayToolName", () => {
  it("strips clientId prefix and formats for display", () => {
    expect(displayToolName(ns("my-conn", "SOME_TOOL"), "my-conn")).toBe(
      "some tool",
    );
  });

  it("returns formatted name when no clientId", () => {
    expect(displayToolName("SOME_TOOL")).toBe("some tool");
  });
});

describe("GatewayClient", () => {
  describe("tool namespacing", () => {
    it("prefixes tool names with the client key namespace code", async () => {
      const clientA = createMockClient([{ name: "toolA" }]);
      const clientB = createMockClient([{ name: "toolB" }]);

      const gw = new GatewayClient({
        a: { client: clientA },
        b: { client: clientB },
      });
      const result = await gw.listTools();

      expect(result.tools).toHaveLength(2);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain(ns("a", "toolA"));
      expect(names).toContain(ns("b", "toolB"));
    });

    it("keeps namespaced tool names short (fits 64-char limit under a second prefix)", () => {
      // conn ids are ~26 chars; the namespace code must be short so a
      // downstream client can add its own prefix and still stay <= 64.
      expect(namespaceCode("conn_MMGhTBDv1JmlGbsdHmSn5").length).toBeLessThan(
        9,
      );
      expect(namespaceCode("conn_MMGhTBDv1JmlGbsdHmSn5")).not.toContain("_");
    });

    it("tags tools with _meta.gatewayClientId", async () => {
      const clientA = createMockClient([{ name: "toolA" }]);
      const gw = new GatewayClient({ myKey: { client: clientA } });
      const result = await gw.listTools();

      expect(result.tools[0].name).toBe(ns("myKey", "toolA"));
      expect((result.tools[0]._meta as any).gatewayClientId).toBe("myKey");
    });

    it("allows same tool name across different clients", async () => {
      const clientA = createMockClient([{ name: "search" }]);
      const clientB = createMockClient([{ name: "search" }]);

      const gw = new GatewayClient({
        a: { client: clientA },
        b: { client: clientB },
      });
      const result = await gw.listTools();

      expect(result.tools).toHaveLength(2);
      expect(result.tools.map((t) => t.name)).toEqual([
        ns("a", "search"),
        ns("b", "search"),
      ]);
    });

    it("gives distinct keys distinct namespace codes", () => {
      expect(namespaceCode("alpha")).not.toBe(namespaceCode("beta"));
      expect(namespaceCode("conn_a")).not.toBe(namespaceCode("conn_b"));
    });
  });

  describe("resilience to failing connections", () => {
    it("skips a connection whose listTools throws, keeps the rest", async () => {
      const healthy = createMockClient([{ name: "ok_tool" }]);
      const broken = createMockClient([{ name: "dead_tool" }]);
      // Simulate a 401 / circuit-breaker-open upstream.
      broken.listTools = mock(async () => {
        throw new Error("circuit breaker is open — downstream unreachable");
      });

      const gw = new GatewayClient({
        healthy: { client: healthy },
        broken: { client: broken },
      });
      const result = await gw.listTools();

      expect(result.tools.map((t) => t.name)).toEqual(["healthy_ok_tool"]);
    });

    it("skips a connection whose lazy factory throws on resolve", async () => {
      const healthy = createMockClient([{ name: "ok_tool" }]);

      const gw = new GatewayClient({
        healthy: { client: healthy },
        broken: {
          client: () => {
            throw new Error("Unauthorized: Authentication required");
          },
        },
      });
      const result = await gw.listTools();

      expect(result.tools.map((t) => t.name)).toEqual(["healthy_ok_tool"]);
    });

    it("degrades resources and prompts the same way", async () => {
      const healthy = createMockClient(
        [],
        [{ uri: "res://ok", name: "ok" }],
        [{ name: "ok_prompt" }],
      );
      const broken = createMockClient();
      broken.listResources = mock(async () => {
        throw new Error("boom");
      });
      broken.listPrompts = mock(async () => {
        throw new Error("boom");
      });

      const gw = new GatewayClient({
        healthy: { client: healthy },
        broken: { client: broken },
      });

      expect((await gw.listResources()).resources.map((r) => r.uri)).toEqual([
        "res://ok",
      ]);
      expect((await gw.listPrompts()).prompts.map((p) => p.name)).toEqual([
        "healthy_ok_prompt",
      ]);
    });
  });

  describe("prompt namespacing", () => {
    it("prefixes prompt names with slugified client key", async () => {
      const client = createMockClient([], [], [{ name: "greet" }]);
      const gw = new GatewayClient({ server: { client } });
      const result = await gw.listPrompts();

      expect(result.prompts[0].name).toBe(ns("server", "greet"));
    });
  });

  describe("routing", () => {
    it("callTool routes to correct client with original name", async () => {
      const clientA = createMockClient([{ name: "toolA" }]);
      const clientB = createMockClient([{ name: "toolB" }]);

      const gw = new GatewayClient({
        a: { client: clientA },
        b: { client: clientB },
      });

      await gw.callTool({ name: ns("b", "toolB"), arguments: {} });
      expect(clientB.callTool).toHaveBeenCalledWith(
        { name: "toolB", arguments: {} },
        undefined,
        undefined,
      );
      expect(clientA.callTool).not.toHaveBeenCalled();
    });

    it("callTool works without listing first", async () => {
      const client = createMockClient([{ name: "doStuff" }]);
      const gw = new GatewayClient({ srv: { client } });

      await gw.callTool({ name: ns("srv", "doStuff"), arguments: { x: 1 } });
      expect(client.callTool).toHaveBeenCalledWith(
        { name: "doStuff", arguments: { x: 1 } },
        undefined,
        undefined,
      );
    });

    it("readResource routes to correct client", async () => {
      const clientA = createMockClient(
        [],
        [{ uri: "file:///a.txt", name: "a" }],
      );
      const clientB = createMockClient(
        [],
        [{ uri: "file:///b.txt", name: "b" }],
      );

      const gw = new GatewayClient({
        a: { client: clientA },
        b: { client: clientB },
      });
      await gw.listResources();

      await gw.readResource({ uri: "file:///b.txt" });
      expect(clientB.readResource).toHaveBeenCalled();
      expect(clientA.readResource).not.toHaveBeenCalled();
    });

    it("getPrompt routes to correct client with original name", async () => {
      const clientA = createMockClient([], [], [{ name: "promptA" }]);
      const clientB = createMockClient([], [], [{ name: "promptB" }]);

      const gw = new GatewayClient({
        a: { client: clientA },
        b: { client: clientB },
      });

      await gw.getPrompt({ name: ns("b", "promptB"), arguments: {} });
      expect(clientB.getPrompt).toHaveBeenCalledWith({
        name: "promptB",
        arguments: {},
      });
      expect(clientA.getPrompt).not.toHaveBeenCalled();
    });

    it("throws for unknown namespace when not found by original name", async () => {
      const gw = new GatewayClient({
        a: { client: createMockClient([{ name: "t" }]) },
      });

      await expect(
        gw.callTool({ name: "unknown_t", arguments: {} }),
      ).rejects.toThrow(/unknown namespace.*not found by original name/);
    });

    it("throws for name without separator when not found", async () => {
      const gw = new GatewayClient({
        a: { client: createMockClient([{ name: "t" }]) },
      });

      await expect(
        gw.callTool({ name: "noprefix", arguments: {} }),
      ).rejects.toThrow(/could not resolve tool/);
    });

    it("resolves un-namespaced tool name by searching clients", async () => {
      const clientA = createMockClient([{ name: "TOOL_A" }]);
      const clientB = createMockClient([{ name: "TOOL_B" }]);
      const gw = new GatewayClient({
        "conn-abc": { client: clientA },
        "conn-def": { client: clientB },
      });

      // Call with un-namespaced name — should find TOOL_B on conn-def
      await gw.callTool({ name: "TOOL_B", arguments: { x: 1 } });
      expect(clientB.callTool).toHaveBeenCalledWith(
        { name: "TOOL_B", arguments: { x: 1 } },
        undefined,
        undefined,
      );
    });
  });

  describe("lazy factory", () => {
    it("factory is called on first use and cached", async () => {
      const client = createMockClient([{ name: "lazy_tool" }]);
      const factory = mock(() => client);

      const gw = new GatewayClient({ lazy: { client: factory } });

      expect(factory).not.toHaveBeenCalled();

      await gw.listTools();
      expect(factory).toHaveBeenCalledTimes(1);

      gw.refresh();
      await gw.listTools();
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("async factory is supported", async () => {
      const client = createMockClient([{ name: "async_tool" }]);
      const factory = mock(async () => client);

      const gw = new GatewayClient({ async: { client: factory } });
      const result = await gw.listTools();

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe(ns("async", "async_tool"));
    });
  });

  describe("per-client selection", () => {
    it("filters tools by selected names", async () => {
      const client = createMockClient([
        { name: "toolA" },
        { name: "toolB" },
        { name: "toolC" },
      ]);

      const gw = new GatewayClient({
        c: { client, tools: ["toolA", "toolC"] },
      });

      const result = await gw.listTools();
      expect(result.tools).toHaveLength(2);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain(ns("c", "toolA"));
      expect(names).toContain(ns("c", "toolC"));
      expect(names).not.toContain(ns("c", "toolB"));
    });

    it("empty tools array blocks all tools", async () => {
      const clientA = createMockClient([{ name: "t1" }]);
      const clientB = createMockClient([{ name: "t2" }]);

      const gw = new GatewayClient({
        a: { client: clientA, tools: [] },
        b: { client: clientB },
      });

      const result = await gw.listTools();
      expect(result.tools.map((t) => t.name)).toEqual([ns("b", "t2")]);
    });

    it("filters resources by selected URIs", async () => {
      const client = createMockClient(
        [],
        [
          { uri: "file:///a.txt", name: "a" },
          { uri: "file:///b.txt", name: "b" },
        ],
      );

      const gw = new GatewayClient({
        c: { client, resources: ["file:///a.txt"] },
      });

      const result = await gw.listResources();
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].uri).toBe("file:///a.txt");
    });

    it("filters resources by selected names (name-first IDs)", async () => {
      const client = createMockClient(
        [],
        [
          { uri: "file:///a.txt", name: "a" },
          { uri: "file:///b.txt", name: "b" },
        ],
      );

      const gw = new GatewayClient({
        c: { client, resources: ["a"] },
      });

      const result = await gw.listResources();
      expect(result.resources).toHaveLength(1);
      expect(result.resources[0].uri).toBe("file:///a.txt");
    });

    it("filters prompts by selected names", async () => {
      const client = createMockClient([], [], [{ name: "p1" }, { name: "p2" }]);

      const gw = new GatewayClient({
        c: { client, prompts: ["p2"] },
      });

      const result = await gw.listPrompts();
      expect(result.prompts).toHaveLength(1);
      expect(result.prompts[0].name).toBe(ns("c", "p2"));
    });

    it("per-client selection across multiple clients", async () => {
      const gw = new GatewayClient({
        a: {
          client: createMockClient([{ name: "a1" }, { name: "a2" }]),
          tools: ["a1"],
        },
        b: {
          client: createMockClient([{ name: "b1" }, { name: "b2" }]),
          tools: ["b2"],
        },
      });

      const result = await gw.listTools();
      expect(result.tools.map((t) => t.name)).toEqual([
        ns("a", "a1"),
        ns("b", "b2"),
      ]);
    });
  });

  describe("getResolvedClient", () => {
    it("returns the resolved client", async () => {
      const client = createMockClient([]);
      const gw = new GatewayClient({ k: { client } });
      expect(await gw.getResolvedClient("k")).toBe(client);
    });

    it("throws for unknown key", async () => {
      const gw = new GatewayClient({});
      await expect(gw.getResolvedClient("x")).rejects.toThrow();
    });
  });

  describe("refresh()", () => {
    it("invalidates cache so next list re-fetches", async () => {
      const client = createMockClient([{ name: "tool1" }]);
      const gw = new GatewayClient({ c: { client } });

      await gw.listTools();
      expect(client.listTools).toHaveBeenCalledTimes(1);

      await gw.listTools();
      expect(client.listTools).toHaveBeenCalledTimes(1);

      gw.refresh();
      await gw.listTools();
      expect(client.listTools).toHaveBeenCalledTimes(2);
    });
  });

  describe("close()", () => {
    it("calls close on all resolved clients", async () => {
      const clientA = createMockClient([{ name: "a" }]);
      const clientB = createMockClient([{ name: "b" }]);

      const gw = new GatewayClient({
        a: { client: clientA },
        b: { client: clientB },
      });
      await gw.listTools();

      await gw.close();

      expect(clientA.close).toHaveBeenCalled();
      expect(clientB.close).toHaveBeenCalled();
    });

    it("does not call close on unresolved factory clients", async () => {
      const client = createMockClient([{ name: "a" }]);
      const factory = mock(() => client);

      const gw = new GatewayClient({ lazy: { client: factory } });
      await gw.close();

      expect(factory).not.toHaveBeenCalled();
      expect(client.close).not.toHaveBeenCalled();
    });
  });

  describe("empty clients record", () => {
    it("returns empty tool list", async () => {
      const gw = new GatewayClient({});
      const result = await gw.listTools();
      expect(result.tools).toHaveLength(0);
    });

    it("returns empty resources list", async () => {
      const gw = new GatewayClient({});
      const result = await gw.listResources();
      expect(result.resources).toHaveLength(0);
    });

    it("returns empty prompts list", async () => {
      const gw = new GatewayClient({});
      const result = await gw.listPrompts();
      expect(result.prompts).toHaveLength(0);
    });
  });

  describe("getServerCapabilities", () => {
    it("returns { tools: {}, resources: {}, prompts: {} }", () => {
      const gw = new GatewayClient({});
      const caps = gw.getServerCapabilities();
      expect(caps).toEqual({ tools: {}, resources: {}, prompts: {} });
    });
  });

  describe("getInstructions", () => {
    it("returns undefined", () => {
      const gw = new GatewayClient({});
      expect(gw.getInstructions()).toBeUndefined();
    });
  });

  describe("caching", () => {
    it("caches listTools results across calls", async () => {
      const client = createMockClient([{ name: "tool1" }]);
      const gw = new GatewayClient({ c: { client } });

      const r1 = await gw.listTools();
      const r2 = await gw.listTools();

      expect(r1).toBe(r2);
      expect(client.listTools).toHaveBeenCalledTimes(1);
    });
  });
});
