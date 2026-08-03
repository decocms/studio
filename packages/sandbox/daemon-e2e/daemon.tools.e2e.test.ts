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
  {
    name: "LIST_EMAILS",
    description: "List emails in the inbox",
    inputSchema: {
      type: "object",
      properties: { folder: { type: "string" } },
    },
  },
  {
    name: "ARCHIVE_EMAIL",
    description: "Archive an email by id",
    inputSchema: {
      type: "object",
      properties: { emailId: { type: "string" } },
      required: ["emailId"],
    },
  },
];

let stub: ReturnType<typeof Bun.serve>;
let stubUrl: string;
let d: Daemon;

/** One stub Virtual MCP serving `tools`. The transport is session-bound, so a
 *  re-sync needs its own stub rather than a second session on this one. */
async function startStubMcp(tools: typeof TOOLS) {
  const server = new Server(
    { name: "stub-mcp", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({
    content: [{ type: "text", text: "{}" }],
    structuredContent: {},
  }));
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);
  const serve = Bun.serve({
    port: 0,
    fetch: (req) => transport.handleRequest(req),
  });
  return {
    serve,
    url: `http://localhost:${serve.port}/mcp/virtual-mcp/test`,
  };
}

beforeEach(async () => {
  const started = await startStubMcp(TOOLS);
  stub = started.serve;
  stubUrl = started.url;

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

function post(path: string, body: unknown): Promise<Response> {
  return fetch(url(d, path), {
    method: "POST",
    headers: jsonAuthHeaders(),
    body: JSON.stringify(body),
  });
}

describe("POST /_sandbox/tools/sync", () => {
  test("writes one JSON Schema file per tool into the workspace", async () => {
    const res = await sync({
      url: stubUrl,
      headers: { Authorization: "Bearer k" },
    });
    expect(res.status).toBe(200);
    const out = await res.json();
    expect(out.count).toBe(4);
    expect(out.tools.sort()).toEqual([
      "ARCHIVE_EMAIL",
      "LIST_CUSTOMERS",
      "LIST_EMAILS",
      "SEND_EMAIL",
    ]);

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

  test("materializes the endpoint file next to the catalog", async () => {
    const res = await sync({
      url: stubUrl,
      headers: { Authorization: "Bearer k", "x-org-id": "org_1" },
      expiresAt: 1234,
    });
    expect(res.status).toBe(200);

    const endpoint = JSON.parse(
      readFileSync(catalogPath(".endpoint.json"), "utf-8"),
    );
    expect(endpoint).toEqual({
      url: stubUrl,
      headers: { Authorization: "Bearer k", "x-org-id": "org_1" },
      expiresAt: 1234,
    });
  });

  test("rejects a malformed body with 400", async () => {
    const res = await sync({ headers: {} }); // missing url
    expect(res.status).toBe(400);
  });

  test("rejects an empty url with 400, writes no endpoint file", async () => {
    // Regression: the decopilot in-process sentinel (`url: ""`) used to be
    // forwarded here and materialized a broken .endpoint.json.
    const res = await sync({ url: "", headers: {} });
    expect(res.status).toBe(400);
    expect(existsSync(catalogPath(".endpoint.json"))).toBe(false);
  });

  test("surfaces an unreachable endpoint as 502, endpoint file still written", async () => {
    const res = await sync({
      url: "http://127.0.0.1:1/mcp/virtual-mcp/test",
      headers: {},
    });
    expect(res.status).toBe(502);
    // The endpoint file needs no MCP round-trip — `call` keeps working even
    // when the tool listing fails.
    expect(existsSync(catalogPath(".endpoint.json"))).toBe(true);
  });

  test("prunes tools that disappeared, keeping the endpoint dotfile", async () => {
    expect((await sync({ url: stubUrl, headers: {} })).status).toBe(200);
    expect(existsSync(catalogPath("SEND_EMAIL.json"))).toBe(true);

    // The Virtual MCP dropped a tool (renamed or removed upstream).
    const shrunk = await startStubMcp(
      TOOLS.filter((t) => t.name !== "SEND_EMAIL"),
    );
    const res = await sync({ url: shrunk.url, headers: {} });
    shrunk.serve.stop(true);
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(3);

    // Stale tool gone, survivors intact...
    expect(existsSync(catalogPath("SEND_EMAIL.json"))).toBe(false);
    expect(existsSync(catalogPath("LIST_CUSTOMERS.json"))).toBe(true);
    // ...and the prune (which targets non-dot *.json) spared the dotfile.
    expect(existsSync(catalogPath(".endpoint.json"))).toBe(true);
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

// The whole point of the catalog: a coding agent, handed "archive all my
// emails", discovers which of the org's tools to script against straight from
// disk — via the same glob/grep/bash routes its shell uses. No LLM needed to
// prove the discovery contract holds end-to-end.
describe("use case: agent discovers email tools from the catalog", () => {
  test("glob + grep + read surface ARCHIVE_EMAIL and its input contract", async () => {
    expect((await sync({ url: stubUrl, headers: {} })).status).toBe(200);

    // 1. glob the catalog the way an agent enumerates available tools.
    const globbed = await post("/_sandbox/glob", {
      pattern: ".deco/tools/*.json",
    }).then((r) => r.json());
    expect(globbed.files).toContain(".deco/tools/ARCHIVE_EMAIL.json");
    expect(globbed.files).toContain(".deco/tools/LIST_EMAILS.json");

    // 2. grep descriptions to narrow to the email tools (POSIX grep, always
    //    present — not the ripgrep route). LIST_CUSTOMERS must NOT match.
    const grep = await post("/_sandbox/bash", {
      command: "grep -il email .deco/tools/*.json | xargs -n1 basename | sort",
    }).then((r) => r.json());
    expect(grep.exitCode).toBe(0);
    expect(grep.stdout.trim().split("\n")).toEqual([
      "ARCHIVE_EMAIL.json",
      "LIST_EMAILS.json",
      "SEND_EMAIL.json",
    ]);

    // 3. read ARCHIVE_EMAIL's schema — the contract the agent scripts against.
    const schema = JSON.parse(
      readFileSync(catalogPath("ARCHIVE_EMAIL.json"), "utf-8"),
    );
    expect(schema.name).toBe("ARCHIVE_EMAIL");
    expect(schema.inputSchema.required).toEqual(["emailId"]);
  });
});
