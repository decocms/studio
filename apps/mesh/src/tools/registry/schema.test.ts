import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RegistryGetOutputSchema, RegistryListOutputSchema } from "./schema";

/**
 * Regression: the registry `LIST` and `GET` tools failed at runtime with
 * `-32602: Structured content does not match the tool's output schema`
 * (`data/items/N must NOT have additional properties` / `data/item must NOT
 * have additional properties`) on every call, while `SEARCH` worked.
 *
 * Cause: the item output schema was a closed object, advertised as JSON Schema
 * with `additionalProperties: false`. The deco store validates output with Zod
 * (which strips unknown keys, so the response is returned), but MCP clients —
 * e.g. the mesh proxy via `client.callTool` — re-validate `structuredContent`
 * with Ajv, which rejects items carrying fields not modeled in the schema
 * (`is_unlisted`, unmodeled `server.json` keys, etc.). `SEARCH` was unaffected
 * because it returns a slim, exactly-projected object.
 *
 * These tests reproduce the proxy's client-side validation with a real
 * in-memory MCP server <-> client round-trip (the proxy lists tools, which
 * caches each tool's advertised output schema, then calls the tool).
 */
describe("registry output schema – proxy round-trip validation", () => {
  const baseItem = {
    id: "deco/example",
    name: "example",
    title: "Example",
    description: "An example",
    server: { name: "example" },
    is_public: true,
    is_unlisted: false,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
  };

  async function roundTrip(
    toolId: "LIST" | "GET",
    outputSchema:
      | typeof RegistryListOutputSchema
      | typeof RegistryGetOutputSchema,
    result: unknown,
  ) {
    const server = new McpServer({ name: "test-registry", version: "0.0.0" });
    server.registerTool(
      toolId,
      { description: toolId, outputSchema },
      async () => ({
        structuredContent: result as Record<string, unknown>,
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      }),
    );

    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      // The mesh proxy lists tools (caching each tool's advertised output
      // schema), then calls the tool. The SDK client only validates output for
      // tools whose schema was cached via listTools().
      await client.listTools();
      return await client.callTool({ name: toolId, arguments: {} });
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("LIST: accepts items carrying the top-level is_unlisted field", async () => {
    const result = await roundTrip("LIST", RegistryListOutputSchema, {
      items: [baseItem],
      totalCount: 1,
      hasMore: false,
    });
    expect(result.isError).toBeFalsy();
    expect(
      (result.structuredContent as { totalCount: number }).totalCount,
    ).toBe(1);
  });

  it("LIST: accepts unmodeled keys in server.json and _meta (open data)", async () => {
    const item = {
      ...baseItem,
      server: {
        name: "example",
        $schema: "https://modelcontextprotocol.io/schemas/server.json",
        status: "active",
        packages: [
          {
            identifier: "@foo/bar",
            version: "1.0.0",
            registry_type: "npm",
            transport: { type: "stdio" },
            environment_variables: [{ name: "TOKEN" }],
          },
        ],
        icons: [{ src: "https://x/icon.png", sizes: "48x48", theme: "dark" }],
        repository: { url: "https://github.com/foo/bar", id: "123" },
      },
      _meta: {
        "mcp.mesh": { readme_url: "https://example.com/readme", extra: true },
        "some.other.ns": { whatever: 1 },
      },
      some_future_field: "tolerated",
    };
    const result = await roundTrip("LIST", RegistryListOutputSchema, {
      items: [item],
      totalCount: 1,
      hasMore: false,
      nextCursor: "24",
    });
    expect(result.isError).toBeFalsy();
  });

  it("LIST: accepts a readme_url with spaces / non-ASCII (valid URL, not strict URI)", async () => {
    const item = {
      ...baseItem,
      _meta: {
        "mcp.mesh": {
          readme_url: "https://exämple.com/path with spaces/README.md",
        },
      },
    };
    const result = await roundTrip("LIST", RegistryListOutputSchema, {
      items: [item],
      totalCount: 1,
      hasMore: false,
    });
    expect(result.isError).toBeFalsy();
  });

  it("GET: accepts a full item (data/item must not be rejected)", async () => {
    const result = await roundTrip("GET", RegistryGetOutputSchema, {
      item: {
        ...baseItem,
        _meta: { "mcp.mesh": { readme_url: "https://example.com/a b" } },
      },
    });
    expect(result.isError).toBeFalsy();
    expect((result.structuredContent as { item: { id: string } }).item.id).toBe(
      "deco/example",
    );
  });
});
