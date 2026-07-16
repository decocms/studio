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

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

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
let baseUrl: string;
let tmp: string;

// A fresh server per test: one stateful transport accepts a single session,
// and each CLI invocation is its own client session.
beforeEach(async () => {
  const server = new Server(
    { name: "fake-crm", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
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

afterEach(() => httpServer?.stop(true));

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "typegen-e2e-"));
});

afterAll(async () => {
  if (tmp) await rm(tmp, { recursive: true, force: true });
});

function runCli(
  args: string[],
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: {
      ...process.env,
      STUDIO_BASE_URL: baseUrl,
      STUDIO_API_KEY: "test-key",
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
}

describe("typegen CLI e2e", () => {
  test("generate writes a client and one schema file per tool", async () => {
    const clientPath = join(tmp, "client.ts");
    const schemasDir = join(tmp, "tools");
    const { code, stderr } = await runCli([
      "--mcp",
      "crm",
      "--output",
      clientPath,
      "--schemas-dir",
      schemasDir,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);

    const clientSrc = await readFile(clientPath, "utf-8");
    expect(clientSrc).toContain("export interface Tools");
    expect(clientSrc).toContain("LIST_CUSTOMERS:");
    expect(clientSrc).toContain("SEND_EMAIL:");

    const files = (await readdir(schemasDir)).sort();
    expect(files).toEqual(["LIST_CUSTOMERS.json", "SEND_EMAIL.json"]);

    const listSchema = JSON.parse(
      await readFile(join(schemasDir, "LIST_CUSTOMERS.json"), "utf-8"),
    );
    expect(listSchema.name).toBe("LIST_CUSTOMERS");
    expect(listSchema.description).toBe(
      "List customers, optionally filtered by plan",
    );
    expect(listSchema.inputSchema.properties.plan.enum).toEqual([
      "free",
      "pro",
    ]);
    expect(listSchema.outputSchema.required).toEqual(["customers"]);
  });

  test("tools lists the available tools", async () => {
    const { code, stdout } = await runCli(["tools", "--mcp", "crm"]);
    expect(code).toBe(0);
    expect(stdout).toContain("LIST_CUSTOMERS — List customers");
    expect(stdout).toContain("SEND_EMAIL — Send an email");
  });

  test("call invokes a tool and prints structured output", async () => {
    const { code, stdout } = await runCli([
      "call",
      "LIST_CUSTOMERS",
      '{"plan":"pro"}',
      "--mcp",
      "crm",
    ]);
    expect(code).toBe(0);
    const result = JSON.parse(stdout);
    expect(result.customers).toHaveLength(1);
    expect(result.customers[0].name).toBe("Ada");
  });

  test("call with default empty input returns all rows", async () => {
    const { code, stdout } = await runCli([
      "call",
      "LIST_CUSTOMERS",
      "--mcp",
      "crm",
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout).customers).toHaveLength(2);
  });

  test("honors legacy MESH_* env vars as a fallback", async () => {
    // No STUDIO_* set; only the legacy names. Must still resolve.
    const env = { ...process.env };
    delete env.STUDIO_BASE_URL;
    delete env.STUDIO_API_KEY;
    env.MESH_BASE_URL = baseUrl;
    env.MESH_API_KEY = "test-key";
    const proc = Bun.spawn(["bun", "run", CLI, "tools", "--mcp", "crm"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
    ]);
    expect(code).toBe(0);
    expect(stdout).toContain("LIST_CUSTOMERS");
  });

  // A workspace as the daemon leaves it: .deco/tools/.endpoint.json holding
  // the run's pre-authenticated endpoint. No flags, no STUDIO_*/MESH_* env.
  // One CLI invocation per test — the stub transport is single-session.
  async function flaglessWorkspace(): Promise<{
    run: (
      args: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
    [Symbol.asyncDispose]: () => Promise<void>;
  }> {
    const workspace = await mkdtemp(join(tmpdir(), "typegen-sandbox-"));
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
        const proc = Bun.spawn(["bun", "run", CLI, ...args], {
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

  test("flagless `tools` inside a sandbox workspace via the endpoint file", async () => {
    await using ws = await flaglessWorkspace();
    const tools = await ws.run(["tools"]);
    expect(tools.stderr).toBe("");
    expect(tools.code).toBe(0);
    expect(tools.stdout).toContain("LIST_CUSTOMERS");
  });

  test("flagless `call` inside a sandbox workspace via the endpoint file", async () => {
    await using ws = await flaglessWorkspace();
    const call = await ws.run(["call", "LIST_CUSTOMERS", '{"plan":"free"}']);
    expect(call.code).toBe(0);
    expect(JSON.parse(call.stdout).customers[0].name).toBe("Grace");
  });

  test("call surfaces tool errors with a non-zero exit", async () => {
    const { code, stderr } = await runCli([
      "call",
      "DOES_NOT_EXIST",
      "--mcp",
      "crm",
    ]);
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});
