import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
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
import type { McpToolClient } from "../lib/mcp";
import { writeSession } from "../lib/session";
import { typegenCommand } from "./typegen";

const TOOLS = [
  {
    name: "LIST_CUSTOMERS",
    description: "List customers.",
    inputSchema: {
      type: "object",
      properties: { plan: { type: "string" } },
    },
    outputSchema: {
      type: "object",
      properties: { customers: { type: "array" } },
    },
  },
];

let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

function fakeMcp(tools: unknown[] = TOOLS) {
  const connects: { url: string; headers: Record<string, string> }[] = [];
  let closed = 0;
  return {
    connects,
    closed: () => closed,
    connectMcp: async (url: URL, headers: Record<string, string>) => {
      connects.push({ url: String(url), headers });
      const client: McpToolClient = {
        listTools: async () => ({ tools }),
        callTool: async () => ({}),
        close: async () => {
          closed++;
        },
      };
      return client;
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-typegen-"));
  out = [];
  err = [];
  logSpy = spyOn(console, "log").mockImplementation((msg: unknown) => {
    out.push(String(msg));
  });
  errSpy = spyOn(console, "error").mockImplementation((msg: unknown) => {
    err.push(String(msg));
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("typegenCommand with a login", () => {
  beforeEach(async () => {
    await writeSession(join(dir, "home"), {
      target: "https://studio.example.com",
      clientId: "client_abc",
      user: { sub: "u_1" },
      accessToken: "at_123",
      createdAt: "2026-05-04T00:00:00.000Z",
    });
  });

  it("generates a client for the agent and writes the schemas", async () => {
    const mcp = fakeMcp();
    const output = join(dir, "client.ts");
    const schemasDir = join(dir, "schemas");
    const code = await typegenCommand({
      dataDir: join(dir, "home"),
      cwd: dir,
      env: {},
      org: "my org",
      agent: "vir_1",
      output,
      schemasDir,
      connectMcp: mcp.connectMcp,
    });

    expect(code).toBe(0);
    expect(mcp.connects).toEqual([
      {
        url: "https://studio.example.com/api/my%20org/mcp/virtual-mcp/vir_1",
        headers: { Authorization: "Bearer at_123" },
      },
    ]);
    expect(mcp.closed()).toBe(1);
    const source = await readFile(output, "utf-8");
    expect(source).toContain("LIST_CUSTOMERS");
    expect(source).toContain('"vir_1"');
    expect(source).toContain("@decocms/typegen");
    expect(await readdir(schemasDir)).toEqual(["LIST_CUSTOMERS.json"]);
    expect(out.join("\n")).toContain("1 tool(s) for vir_1");
  });

  it("needs --org and --agent", async () => {
    const mcp = fakeMcp();
    for (const flags of [{ org: "my-org" }, { agent: "vir_1" }, {}]) {
      const code = await typegenCommand({
        dataDir: join(dir, "home"),
        cwd: dir,
        env: {},
        output: join(dir, "client.ts"),
        connectMcp: mcp.connectMcp,
        ...flags,
      });
      expect(code).toBe(1);
    }
    expect(mcp.connects).toHaveLength(0);
    expect(err.join("\n")).toContain(
      "decocms typegen --org <slug> --agent <id>",
    );
  });

  it("writes nothing when the tool list is malformed", async () => {
    const mcp = fakeMcp([{ name: "NO_SCHEMA" }]);
    const output = join(dir, "client.ts");
    const code = await typegenCommand({
      dataDir: join(dir, "home"),
      cwd: dir,
      env: {},
      org: "my-org",
      agent: "vir_1",
      output,
      connectMcp: mcp.connectMcp,
    });

    expect(code).toBe(1);
    expect(await readdir(dir)).not.toContain("client.ts");
    expect(err.join("\n")).toContain("Unexpected tool list");
  });
});

describe("typegenCommand inside a Studio run", () => {
  async function enterRun(url: string) {
    await mkdir(join(dir, ".deco", "tools"), { recursive: true });
    await writeFile(
      join(dir, ".deco", "tools", ".endpoint.json"),
      JSON.stringify({ url, headers: { Authorization: "Bearer run-key" } }),
    );
  }

  it("generates a client for the run's agent with no flags", async () => {
    await enterRun("https://studio.example.com/mcp/virtual-mcp/vir_run");
    const mcp = fakeMcp();
    const output = join(dir, "client.ts");
    const code = await typegenCommand({
      dataDir: join(dir, "home"),
      cwd: dir,
      env: {},
      output,
      connectMcp: mcp.connectMcp,
    });

    expect(code).toBe(0);
    expect(mcp.connects[0]).toEqual({
      url: "https://studio.example.com/mcp/virtual-mcp/vir_run",
      headers: { Authorization: "Bearer run-key" },
    });
    expect(await readFile(output, "utf-8")).toContain('"vir_run"');
  });

  it("fails when the endpoint names no agent", async () => {
    await enterRun("https://studio.example.com/mcp/self");
    const mcp = fakeMcp();
    const code = await typegenCommand({
      dataDir: join(dir, "home"),
      cwd: dir,
      env: {},
      output: join(dir, "client.ts"),
      connectMcp: mcp.connectMcp,
    });

    expect(code).toBe(1);
    expect(mcp.connects).toHaveLength(0);
    expect(err.join("\n")).toContain("Could not read the agent id");
  });

  it("refuses --agent", async () => {
    await enterRun("https://studio.example.com/mcp/virtual-mcp/vir_run");
    const mcp = fakeMcp();
    const code = await typegenCommand({
      dataDir: join(dir, "home"),
      cwd: dir,
      env: {},
      agent: "vir_other",
      connectMcp: mcp.connectMcp,
    });

    expect(code).toBe(1);
    expect(mcp.connects).toHaveLength(0);
  });
});
