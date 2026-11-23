import { describe, expect, it } from "bun:test";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  CONNECTION_TOOL_CALL,
  CONNECTION_TOOLS_SEARCH,
  closedSchemaKeys,
  rankTools,
  unknownArgumentsMessage,
} from "./gateway";

const tool = (name: string, description = ""): Tool => ({
  name,
  description,
  inputSchema: { type: "object" },
});

const github = [
  tool("search_pull_requests", "Search pull requests across repositories"),
  tool("get_file_contents", "Read a file"),
];

describe("rankTools", () => {
  it("collapses the same tool offered by several connections into one hit", () => {
    const hits = rankTools(
      "pull request",
      [
        { connection: { id: "c1", title: "GitHub" }, tools: github },
        { connection: { id: "c2", title: "GitHub" }, tools: github },
      ],
      10,
      false,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe("search_pull_requests");
    expect(hits[0]!.connections.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(hits[0]!.inputSchema).toBeUndefined();
  });

  it("ranks a name match above a description-only match and honours the limit", () => {
    const hits = rankTools(
      "orders",
      [
        {
          connection: { id: "v", title: "VTEX" },
          tools: [
            tool("GET_PRODUCT", "Product used in orders"),
            tool("LIST_ORDERS", "List"),
            tool("GET_SKU", "Unrelated"),
          ],
        },
      ],
      1,
      true,
    );
    expect(hits.map((h) => h.name)).toEqual(["LIST_ORDERS"]);
    expect(hits[0]!.inputSchema).toEqual({ type: "object" });
  });

  it("returns nothing for a query with no usable words", () => {
    expect(
      rankTools(
        "?",
        [{ connection: { id: "c", title: "x" }, tools: github }],
        5,
        false,
      ),
    ).toEqual([]);
  });
});

describe("CONNECTION_TOOL_CALL arguments bound", () => {
  it("accepts a small arguments payload", () => {
    expect(
      CONNECTION_TOOL_CALL.inputSchema.safeParse({
        connectionId: "c1",
        toolName: "echo",
        arguments: { message: "hi" },
      }).success,
    ).toBe(true);
  });

  it("rejects an oversized arguments payload", () => {
    expect(
      CONNECTION_TOOL_CALL.inputSchema.safeParse({
        connectionId: "c1",
        toolName: "echo",
        arguments: { message: "a".repeat(300 * 1024) },
      }).success,
    ).toBe(false);
  });
});

describe("gateway tools refuse top-level keys they do not accept", () => {
  it("names the unknown keys and lists the accepted ones", () => {
    const parsed = CONNECTION_TOOL_CALL.inputSchema.safeParse({
      connection_id: "c1",
      toolName: "echo",
      args: { message: "hi" },
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toContainEqual(
      expect.objectContaining({
        code: "unrecognized_keys",
        keys: ["connection_id", "args"],
        message:
          'Unknown keys "connection_id", "args" in CONNECTION_TOOL_CALL input. ' +
          "Accepted keys: connectionId, toolName, arguments.",
      }),
    );
  });

  it("refuses the connection tool's own arguments sent at the top level", () => {
    const parsed = CONNECTION_TOOL_CALL.inputSchema.safeParse({
      connectionId: "c1",
      toolName: "echo",
      message: "hi",
    });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'Unknown key "message" in CONNECTION_TOOL_CALL input. ' +
        "Accepted keys: connectionId, toolName, arguments.",
    ]);
  });

  it("does the same for the search", () => {
    const parsed = CONNECTION_TOOLS_SEARCH.inputSchema.safeParse({
      query: "pull request",
      with_schema: true,
    });
    expect(parsed.error?.issues.map((issue) => issue.message)).toEqual([
      'Unknown key "with_schema" in CONNECTION_TOOLS_SEARCH input. ' +
        "Accepted keys: query, limit, withSchema.",
    ]);
  });

  it("bounds how many keys, and how much of each, the message repeats", () => {
    const input: Record<string, unknown> = { query: "x", ["k".repeat(500)]: 1 };
    for (let i = 0; i < 40; i++) input[`extra${i}`] = i;
    const message =
      CONNECTION_TOOLS_SEARCH.inputSchema.safeParse(input).error?.issues[0]
        ?.message;
    expect(message).toContain("and 31 more");
    expect(message).not.toContain("k".repeat(65));
    expect(message!.length).toBeLessThan(400);
  });

  it("leaves a valid call as it was", () => {
    expect(
      CONNECTION_TOOL_CALL.inputSchema.parse({
        connectionId: "c1",
        toolName: "echo",
        arguments: { message: "hi" },
      }),
    ).toEqual({
      connectionId: "c1",
      toolName: "echo",
      arguments: { message: "hi" },
    });
    expect(
      CONNECTION_TOOL_CALL.inputSchema.parse({
        connectionId: "c1",
        toolName: "echo",
      }),
    ).toEqual({ connectionId: "c1", toolName: "echo", arguments: {} });
    expect(CONNECTION_TOOLS_SEARCH.inputSchema.parse({ query: "x" })).toEqual({
      query: "x",
      limit: 8,
      withSchema: false,
    });
  });
});

describe("arguments forwarded to a connection's tool", () => {
  const strict: Tool = {
    name: "search_pull_requests",
    inputSchema: {
      type: "object",
      properties: { owner: { type: "string" }, query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
  };
  const permissive: Tool = {
    name: "get_file_contents",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  };
  const tools = [strict, permissive];

  it("refuses a key a strict schema does not list", () => {
    expect(
      unknownArgumentsMessage(tools, "search_pull_requests", {
        q: "is:open",
        repo_owner: "example",
      }),
    ).toBe(
      'Unknown keys "q", "repo_owner" in arguments for search_pull_requests. ' +
        "Accepted keys: owner, query.",
    );
  });

  it("passes arguments a strict schema lists", () => {
    expect(
      unknownArgumentsMessage(tools, "search_pull_requests", {
        query: "is:open",
        owner: "example",
      }),
    ).toBeNull();
    expect(unknownArgumentsMessage(tools, "search_pull_requests", {})).toBe(
      null,
    );
  });

  it("allows an extra key when the schema does not forbid it", () => {
    expect(
      unknownArgumentsMessage(tools, "get_file_contents", {
        path: "README.md",
        ref: "main",
      }),
    ).toBeNull();
  });

  it("allows anything for a tool Studio holds no schema for", () => {
    expect(unknownArgumentsMessage(tools, "unlisted", { a: 1 })).toBeNull();
    expect(unknownArgumentsMessage([], "echo", { a: 1 })).toBeNull();
    expect(
      unknownArgumentsMessage([null, "echo", { name: "echo" }], "echo", {
        a: 1,
      }),
    ).toBeNull();
  });

  it("says so when a strict tool takes no arguments", () => {
    expect(
      unknownArgumentsMessage(
        [{ name: "ping", inputSchema: { additionalProperties: false } }],
        "ping",
        { verbose: true },
      ),
    ).toBe('Unknown key "verbose" in arguments for ping. It accepts no keys.');
  });
});

describe("closedSchemaKeys", () => {
  it("is null unless the schema plainly forbids extra keys", () => {
    const properties = { a: { type: "string" } };
    expect(
      closedSchemaKeys({ properties, additionalProperties: false }),
    ).toEqual(["a"]);
    for (const schema of [
      undefined,
      null,
      [],
      { properties },
      { properties, additionalProperties: true },
      { properties, additionalProperties: { type: "string" } },
      { properties, additionalProperties: false, patternProperties: {} },
      { properties, additionalProperties: false, allOf: [{ properties }] },
      { properties, additionalProperties: false, anyOf: [{ properties }] },
      { properties, additionalProperties: false, oneOf: [{ properties }] },
      { additionalProperties: false, $ref: "#/$defs/Input" },
      { properties, unevaluatedProperties: false },
    ]) {
      expect(closedSchemaKeys(schema)).toBeNull();
    }
  });
});
