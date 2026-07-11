/**
 * Black-box e2e for POST /_sandbox/tools/sync.
 *
 * Stands up a stub Virtual MCP over HTTP (in-process), points the spawned
 * daemon at it, and asserts the daemon materializes a JSON Schema tool catalog
 * under `<repo>/.deco/tools/`. Same black-box contract as the rest of the
 * daemon suite — the assertions only touch HTTP + the workspace filesystem.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type Daemon,
  HOOK_TIMEOUT_MS,
  jsonAuthHeaders,
  startDaemon,
  stopDaemon,
  url,
} from "./daemon.e2e.helpers";

const TOOLS = [
  {
    name: "LIST_CUSTOMERS",
    description: "List customers",
    inputSchema: {
      type: "object",
      properties: { plan: { type: "string", enum: ["free", "pro"] } },
    },
    outputSchema: {
      type: "object",
      properties: { customers: { type: "array" } },
      required: ["customers"],
    },
  },
  {
    name: "SEND_EMAIL",
    description: "Send an email",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" } },
      required: ["to"],
    },
  },
];

let stub: ReturnType<typeof Bun.serve>;
let stubUrl: string;
let d: Daemon;

beforeEach(async () => {
  const server = new Server(
    { name: "stub-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "{}" }],
    structuredContent: {},
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);
  stub = Bun.serve({ port: 0, fetch: (req) => transport.handleRequest(req) });
  stubUrl = `http://localhost:${stub.port}/mcp/virtual-mcp/test`;

  d = await startDaemon();
}, HOOK_TIMEOUT_MS);

afterEach(async () => {
  stub?.stop(true);
  await stopDaemon(d);
}, HOOK_TIMEOUT_MS);

function sync(body: unknown): Promise<Response> {
  return fetch(url(d, "/_sandbox/tools/sync"), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  });
}

const catalogPath = (file: string) =>
  join(d.appDir, "repo", ".deco", "tools", file);

describe("POST /_sandbox/tools/sync", () => {
  test("writes one JSON Schema file per tool into the workspace", async () => {
    const res = await sync({
      url: stubUrl,
      headers: { Authorization: "Bearer k" },
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.count).toBe(2);
    expect(out.tools.sort()).toEqual(["LIST_CUSTOMERS", "SEND_EMAIL"]);

    expect(existsSync(catalogPath("LIST_CUSTOMERS.json"))).toBe(true);
    expect(existsSync(catalogPath("SEND_EMAIL.json"))).toBe(true);

    const listSchema = JSON.parse(
      readFileSync(catalogPath("LIST_CUSTOMERS.json"), "utf-8"),
    );
    expect(listSchema.name).toBe("LIST_CUSTOMERS");
    expect(listSchema.description).toBe("List customers");
    expect(listSchema.inputSchema.properties.plan.enum).toEqual([
      "free",
      "pro",
    ]);
    expect(listSchema.outputSchema.required).toEqual(["customers"]);
  });

  test("rejects a malformed body with 400", async () => {
    const res = await sync({ headers: {} }); // missing url
    expect(res.status).toBe(400);
  });

  test("surfaces an unreachable endpoint as 502", async () => {
    const res = await sync({
      url: "http://127.0.0.1:1/mcp/virtual-mcp/test",
      headers: {},
    });
    expect(res.status).toBe(502);
  });

  test("requires the daemon bearer token", async () => {
    const res = await fetch(url(d, "/_sandbox/tools/sync"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: stubUrl, headers: {} }),
    });
    expect(res.status).toBe(401);
  });
});
