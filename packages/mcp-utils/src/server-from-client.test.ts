import { describe, it, expect, mock } from "bun:test";
import type { IClient } from "./client-like.ts";
import type {
  ServerCapabilities,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { createServerFromClient } from "./server-from-client.ts";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

function createMockClient(
  overrides: Partial<IClient> & {
    capabilities?: ServerCapabilities;
    instructions?: string;
  } = {},
): IClient {
  const capabilities = overrides.capabilities ?? {
    tools: {},
    resources: {},
    prompts: {},
  };
  const instructions = overrides.instructions;

  return {
    listTools: mock(async (_params) => ({
      tools: [
        {
          name: "tool_a",
          description: "A tool",
          inputSchema: { type: "object" as const },
          outputSchema: { type: "object" as const, properties: {} },
        },
      ] as Tool[],
    })),
    callTool: mock(async (_params, _resultSchema, _options) => ({
      content: [{ type: "text" as const, text: "result" }],
    })),
    listResources: mock(async (_params) => ({
      resources: [
        {
          uri: "file:///test.txt",
          name: "test",
          mimeType: "text/plain",
        },
      ],
    })),
    readResource: mock(async (params) => ({
      contents: [
        {
          uri: params.uri,
          text: "content",
          mimeType: "text/plain",
        },
      ],
    })),
    listResourceTemplates: mock(async (_params) => ({
      resourceTemplates: [
        {
          uriTemplate: "file:///{path}",
          name: "files",
        },
      ],
    })),
    listPrompts: mock(async (_params) => ({
      prompts: [{ name: "greet", description: "A greeting" }],
    })),
    getPrompt: mock(async (params) => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: `Hello ${params.name}` },
        },
      ],
    })),
    getServerCapabilities: mock(() => capabilities),
    getInstructions: mock(() => instructions),
    close: mock(async () => {}),
    ...overrides,
  };
}

describe("createServerFromClient", () => {
  describe("listTools", () => {
    it("strips outputSchema from tools", async () => {
      const client = createMockClient();
      const server = createServerFromClient(client, {
        name: "test",
        version: "1.0.0",
      });

      const handler = (server.server as any)._requestHandlers.get(
        ListToolsRequestSchema.shape.method.value,
      );

      const result = await handler({
        method: "tools/list",
        params: {},
      });

      expect(result.tools[0]).not.toHaveProperty("outputSchema");
      expect(result.tools[0].name).toBe("tool_a");
      expect(result.tools[0].inputSchema).toBeDefined();
    });
  });

  describe("LLM-safe property keys", () => {
    const unsafeClient = () =>
      createMockClient({
        listTools: mock(async (_params) => ({
          tools: [
            {
              name: "vtex_doc",
              inputSchema: {
                type: "object" as const,
                properties: { acronym: {}, "{fieldName}": {} },
                required: ["{fieldName}"],
              },
            },
          ] as Tool[],
        })),
      });

    it("renames keys Anthropic rejects and restores them on call", async () => {
      const client = unsafeClient();
      const server = createServerFromClient(client, {
        name: "test",
        version: "1.0.0",
      });
      const list = (server.server as any)._requestHandlers.get(
        ListToolsRequestSchema.shape.method.value,
      );
      const call = (server.server as any)._requestHandlers.get(
        CallToolRequestSchema.shape.method.value,
      );

      const listed = await list({ method: "tools/list", params: {} });
      expect(Object.keys(listed.tools[0].inputSchema.properties)).toEqual([
        "acronym",
        "_fieldName_",
      ]);
      expect(listed.tools[0].inputSchema.required).toEqual(["_fieldName_"]);

      await call({
        method: "tools/call",
        params: { name: "vtex_doc", arguments: { _fieldName_: "email" } },
      });
      expect(client.callTool).toHaveBeenCalledWith(
        { name: "vtex_doc", arguments: { "{fieldName}": "email" } },
        undefined,
        undefined,
      );
    });

    it("restores keys for a client that calls without listing first", async () => {
      const client = unsafeClient();
      const server = createServerFromClient(client, {
        name: "test",
        version: "1.0.0",
      });
      const call = (server.server as any)._requestHandlers.get(
        CallToolRequestSchema.shape.method.value,
      );

      await call({
        method: "tools/call",
        params: { name: "vtex_doc", arguments: { _fieldName_: "email" } },
      });
      expect(client.callTool).toHaveBeenCalledWith(
        { name: "vtex_doc", arguments: { "{fieldName}": "email" } },
        undefined,
        undefined,
      );
    });
  });

  describe("callTool", () => {
    it("passes timeout option when toolCallTimeoutMs is set", async () => {
      const client = createMockClient();
      const server = createServerFromClient(
        client,
        { name: "test", version: "1.0.0" },
        { toolCallTimeoutMs: 5000 },
      );

      const handler = (server.server as any)._requestHandlers.get(
        CallToolRequestSchema.shape.method.value,
      );

      await handler({
        method: "tools/call",
        params: { name: "tool_a", arguments: {} },
      });

      expect(client.callTool).toHaveBeenCalledWith(
        { name: "tool_a", arguments: {} },
        undefined,
        { timeout: 5000 },
      );
    });
  });

  describe("resources handlers", () => {
    it("registers resource handlers when capabilities include resources", () => {
      const client = createMockClient({
        capabilities: { resources: {}, tools: {} },
      });
      const server = createServerFromClient(client, {
        name: "test",
        version: "1.0.0",
      });

      const listHandler = (server.server as any)._requestHandlers.get(
        ListResourcesRequestSchema.shape.method.value,
      );
      const readHandler = (server.server as any)._requestHandlers.get(
        ReadResourceRequestSchema.shape.method.value,
      );
      const templatesHandler = (server.server as any)._requestHandlers.get(
        ListResourceTemplatesRequestSchema.shape.method.value,
      );

      expect(listHandler).toBeDefined();
      expect(readHandler).toBeDefined();
      expect(templatesHandler).toBeDefined();
    });

    it("does NOT register resource handlers when capabilities lack resources", () => {
      const client = createMockClient({
        capabilities: { tools: {} },
      });
      const server = createServerFromClient(client, {
        name: "test",
        version: "1.0.0",
      });

      const listHandler = (server.server as any)._requestHandlers.get(
        ListResourcesRequestSchema.shape.method.value,
      );

      expect(listHandler).toBeUndefined();
    });
  });

  describe("prompts handlers", () => {
    it("registers prompt handlers when capabilities include prompts", () => {
      const client = createMockClient({
        capabilities: { prompts: {}, tools: {} },
      });
      const server = createServerFromClient(client, {
        name: "test",
        version: "1.0.0",
      });

      const listHandler = (server.server as any)._requestHandlers.get(
        ListPromptsRequestSchema.shape.method.value,
      );
      const getHandler = (server.server as any)._requestHandlers.get(
        GetPromptRequestSchema.shape.method.value,
      );

      expect(listHandler).toBeDefined();
      expect(getHandler).toBeDefined();
    });

    it("does NOT register prompt handlers when capabilities lack prompts", () => {
      const client = createMockClient({
        capabilities: { tools: {} },
      });
      const server = createServerFromClient(client, {
        name: "test",
        version: "1.0.0",
      });

      const listHandler = (server.server as any)._requestHandlers.get(
        ListPromptsRequestSchema.shape.method.value,
      );

      expect(listHandler).toBeUndefined();
    });

    it("delegates getPrompt with default empty arguments", async () => {
      const client = createMockClient({
        capabilities: { prompts: {}, tools: {} },
      });
      const server = createServerFromClient(client, {
        name: "test",
        version: "1.0.0",
      });

      const handler = (server.server as any)._requestHandlers.get(
        GetPromptRequestSchema.shape.method.value,
      );

      await handler({
        method: "prompts/get",
        params: { name: "greet" },
      });

      // Should provide default empty arguments when none specified
      expect(client.getPrompt).toHaveBeenCalledWith({
        name: "greet",
        arguments: {},
      });
    });
  });

  describe("options", () => {
    it("uses provided capabilities over client capabilities", () => {
      const client = createMockClient({
        capabilities: { tools: {}, resources: {}, prompts: {} },
      });
      const server = createServerFromClient(
        client,
        { name: "test", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );

      // With only tools in capabilities, no resource or prompt handlers
      const resourceHandler = (server.server as any)._requestHandlers.get(
        ListResourcesRequestSchema.shape.method.value,
      );
      expect(resourceHandler).toBeUndefined();
    });
  });
});
