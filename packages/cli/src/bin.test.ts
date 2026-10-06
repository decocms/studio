/**
 * End-to-end: stand up a fake "org MCP" (a tiny customers CRM) over HTTP, then
 * drive the real CLI against it — generate schema files + a typed client, list
 * tools, and call a tool — asserting the whole loop an agent would use.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("./bin.ts", import.meta.url));

const CUSTOMERS = [
  { id: "c1", name: "Ada", email: "ada@example.com", plan: "pro" },
  { id: "c2", name: "Grace", email: "grace@example.com", plan: "free" },
];

const TOOLS = [
  {
    name: "LIST_CUSTOMERS",
    description: "List customers, optionally filtered by plan",
    inputSchema: {
      type: "object",
      properties: { plan: { type: "string", enum: ["free", "pro"] } },
    },
    outputSchema: {
      type: "object",
      properties: {
        customers: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              email: { type: "string" },
            },
            required: ["id", "name", "email"],
          },
        },
      },
      required: ["customers"],
    },
  },
  {
    name: "SEND_EMAIL",
    description: "Send an email to a customer",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject"],
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string" }, delivered: { type: "boolean" } },
      required: ["id", "delivered"],
    },
  },
];

let httpServer: ReturnType<typeof Bun.serve>;
let mcpServer: Server;
let baseUrl: string;
let tmp: string;

// A fresh server per test: one stateful transport accepts a single session,
// and each CLI invocation is its own client session.
beforeEach(async () => {
  const server = (mcpServer = new Server(
    { name: "fake-crm", version: "1.0.0" },
    { capabilities: { tools: {} } },
  ));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    let out: unknown;
    if (name === "LIST_CUSTOMERS") {
      const plan = (args as { plan?: string })?.plan;
      out = {
        customers: (plan
          ? CUSTOMERS.filter((c) => c.plan === plan)
          : CUSTOMERS
        ).map(({ id, name, email }) => ({ id, name, email })),
      };
    } else if (name === "SEND_EMAIL") {
      out = { id: "msg_1", delivered: true };
    } else {
      throw new Error(`unknown tool ${name}`);
    }
    return {
      content: [{ type: "text", text: JSON.stringify(out) }],
      structuredContent: out as Record<string, unknown>,
    };
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  httpServer = Bun.serve({
    port: 0,
    fetch: (req) => transport.handleRequest(req),
  });
  baseUrl = `http://localhost:${httpServer.port}`;
});

afterEach(async () => {
  // Close the MCP server (which closes its transport and any session
  // streams) BEFORE stopping the HTTP server: a lingering session stream
  // keeps the worker's event loop alive after the suite finishes — under
  // `bun test --parallel` that hangs the whole run at exit (the coordinator
  // waits on worker exit; this cost a 10-minute timeout on CI once).
  await mcpServer?.close().catch(() => {});
  httpServer?.stop(true);
});

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "decocms-e2e-"));
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

describe("decocms binary inside a sandbox workspace", () => {
  async function flaglessWorkspace(): Promise<{
    run: (
      args: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
    [Symbol.asyncDispose]: () => Promise<void>;
  }> {
    const workspace = await mkdtemp(join(tmpdir(), "decocms-sandbox-"));
    const toolsDir = join(workspace, ".deco", "tools");
    await mkdir(toolsDir, { recursive: true });
    await writeFile(
      join(toolsDir, ".endpoint.json"),
      JSON.stringify({
        url: `${baseUrl}/mcp/virtual-mcp/crm`,
        headers: { Authorization: "Bearer test-key" },
        expiresAt: 1,
      }),
    );

    const env = { ...process.env };
    delete env.STUDIO_BASE_URL;
    delete env.STUDIO_API_KEY;
    delete env.STUDIO_MCP_ID;
    delete env.MESH_BASE_URL;
    delete env.MESH_API_KEY;
    delete env.MESH_MCP_ID;

    return {
      run: (args: string[]) => {
        const proc = Bun.spawn(["bun", "run", BIN, ...args], {
          cwd: workspace,
          env,
          stdout: "pipe",
          stderr: "pipe",
        });
        return Promise.all([
          proc.exited,
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
      },
      [Symbol.asyncDispose]: () =>
        rm(workspace, { recursive: true, force: true }),
    };
  }
  test("whoami reports the run's endpoint", async () => {
    await using ws = await flaglessWorkspace();
    const whoami = await ws.run(["auth", "whoami"]);
    expect(whoami.code).toBe(0);
    expect(whoami.stdout).toContain(`${baseUrl}/mcp/virtual-mcp/crm`);
  });

  test("tools list shows the run's tools with no flags", async () => {
    await using ws = await flaglessWorkspace();
    const tools = await ws.run(["tools", "list"]);
    expect(tools.stderr).toBe("");
    expect(tools.code).toBe(0);
    expect(tools.stdout).toContain("LIST_CUSTOMERS");
    expect(tools.stdout).toContain("SEND_EMAIL");
  });

  test("tools call passes -d arguments and prints the structured result", async () => {
    await using ws = await flaglessWorkspace();
    const call = await ws.run([
      "tools",
      "call",
      "LIST_CUSTOMERS",
      "-d",
      '{"plan":"free"}',
    ]);
    expect(call.code).toBe(0);
    expect(JSON.parse(call.stdout).customers[0].name).toBe("Grace");
  });

  test("tools call exits non-zero for an unknown tool", async () => {
    await using ws = await flaglessWorkspace();
    const call = await ws.run(["tools", "call", "DOES_NOT_EXIST"]);
    expect(call.code).not.toBe(0);
  });

  test("typegen writes a client and schemas for the run's agent", async () => {
    await using ws = await flaglessWorkspace();
    const clientPath = join(tmp, "run-client.ts");
    const schemasDir = join(tmp, "run-schemas");
    const gen = await ws.run([
      "typegen",
      "--output",
      clientPath,
      "--schemas-dir",
      schemasDir,
    ]);
    expect(gen.stderr).toBe("");
    expect(gen.code).toBe(0);
    const clientSrc = await readFile(clientPath, "utf-8");
    expect(clientSrc).toContain("export type Tools = {");
    expect(clientSrc).toContain("LIST_CUSTOMERS:");
    expect(clientSrc).toContain('mcpId: "crm"');
    expect(clientSrc).toContain('from "@decocms/cli"');
    expect((await readdir(schemasDir)).sort()).toEqual([
      "LIST_CUSTOMERS.json",
      "SEND_EMAIL.json",
    ]);
  });

  test("org-wide commands are refused with only a run's key", async () => {
    await using ws = await flaglessWorkspace();
    const orgs = await ws.run(["orgs"]);
    expect(orgs.code).toBe(1);
    expect(orgs.stderr).toContain("needs a login");
  });
});
