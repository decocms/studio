import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../lib/session";
import { toolsCommand } from "./tools";

const TOOLS = {
  tools: [
    {
      name: "THREAD_LIST",
      description: "List threads.\nSecond line.",
      inputSchema: { type: "object" },
    },
    { name: "THREAD_GET", description: "Get one thread." },
    { name: "ORGANIZATION_LIST", description: "List organizations." },
  ],
};

let dir: string;
let out: string[];
let err: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
let calls: { url: string; init: RequestInit }[];
let stdout: string;

const output = async (chunk: Uint8Array) => {
  stdout += new TextDecoder().decode(chunk);
};

function respondWith(body: unknown, status = 200) {
  return (async (input: URL | string, init: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-tools-"));
  out = [];
  err = [];
  calls = [];
  stdout = "";
  logSpy = spyOn(console, "log").mockImplementation((msg: unknown) => {
    out.push(String(msg));
  });
  errSpy = spyOn(console, "error").mockImplementation((msg: unknown) => {
    err.push(String(msg));
  });
  await writeSession(dir, {
    target: "https://studio.example.com",
    clientId: "client_abc",
    user: { sub: "u_1" },
    accessToken: "at_123",
    createdAt: "2026-05-04T00:00:00.000Z",
  });
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("toolsCommand list", () => {
  it("prints one line per tool with the first description line", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "list",
      org: "my-org",
      fetch: respondWith(TOOLS),
    });

    expect(code).toBe(0);
    expect(calls[0]!.url).toBe("https://studio.example.com/api/my-org/tools");
    expect(out).toEqual([
      "THREAD_LIST\tList threads.",
      "THREAD_GET\tGet one thread.",
      "ORGANIZATION_LIST\tList organizations.",
    ]);
  });

  it("filters by name or description, case-insensitively", async () => {
    await toolsCommand({
      dataDir: dir,
      subcommand: "list",
      arg: "organizations",
      org: "my-org",
      fetch: respondWith(TOOLS),
    });

    expect(out).toEqual(["ORGANIZATION_LIST\tList organizations."]);
  });

  it("prints full tool objects with --json", async () => {
    await toolsCommand({
      dataDir: dir,
      subcommand: "list",
      arg: "thread_list",
      org: "my-org",
      json: true,
      fetch: respondWith(TOOLS),
    });

    expect(JSON.parse(out[0]!)).toEqual([TOOLS.tools[0]]);
  });

  it("fails on a response that is not a tool list", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "list",
      org: "my-org",
      fetch: respondWith({ tools: "nope" }),
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unexpected response");
  });

  it("passes a non-2xx through", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "list",
      org: "not-mine",
      fetch: respondWith({ error: "Forbidden" }, 403),
      output,
    });

    expect(code).toBe(1);
    expect(stdout).toBe('{"error":"Forbidden"}');
  });
});

describe("toolsCommand describe", () => {
  it("prints the tool's schema", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "describe",
      arg: "THREAD_LIST",
      org: "my-org",
      fetch: respondWith(TOOLS),
    });

    expect(code).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual(TOOLS.tools[0]);
  });

  it("exits 1 for an unknown tool", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "describe",
      arg: "NOPE",
      org: "my-org",
      fetch: respondWith(TOOLS),
    });

    expect(code).toBe(1);
    expect(err.join("\n")).toContain("Unknown tool: NOPE");
  });
});

describe("toolsCommand call", () => {
  it("POSTs the arguments to the tool route", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "call",
      arg: "THREAD_GET",
      org: "my org",
      data: '{"id":"t_1"}',
      fetch: respondWith({ id: "t_1" }),
      output,
    });

    expect(code).toBe(0);
    expect(calls[0]!.url).toBe(
      "https://studio.example.com/api/my%20org/tools/THREAD_GET",
    );
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.body).toBe('{"id":"t_1"}');
    expect(stdout).toBe('{"id":"t_1"}');
  });

  it("sends {} when no arguments are given", async () => {
    await toolsCommand({
      dataDir: dir,
      subcommand: "call",
      arg: "ORGANIZATION_LIST",
      org: "my-org",
      fetch: respondWith({}),
      output,
    });

    expect(calls[0]!.init.body).toBe("{}");
  });

  it("exits 1 on a tool error and keeps the error body", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "call",
      arg: "THREAD_GET",
      org: "my-org",
      data: "{}",
      fetch: respondWith({ error: "Invalid input", issues: [] }, 400),
      output,
    });

    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({ error: "Invalid input", issues: [] });
  });
});

describe("toolsCommand usage", () => {
  for (const [label, options] of [
    ["no subcommand", {}],
    ["unknown subcommand", { subcommand: "run", arg: "X" }],
    ["call without a name", { subcommand: "call" }],
    ["describe without a name", { subcommand: "describe" }],
  ] as const) {
    it(`prints usage for ${label}`, async () => {
      const code = await toolsCommand({
        dataDir: dir,
        org: "my-org",
        fetch: respondWith(TOOLS),
        ...options,
      });
      expect(code).toBe(1);
      expect(calls).toHaveLength(0);
      expect(err.join("\n")).toContain("decocms tools list");
    });
  }

  it("requires --org", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "list",
      fetch: respondWith(TOOLS),
    });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(err.join("\n")).toContain("Missing --org");
  });
});
