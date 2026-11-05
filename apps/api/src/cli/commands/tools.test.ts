import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../lib/session";
import { formatToolSignature, toolsCommand } from "./tools";

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
let chunks: Uint8Array[];

const output = async (chunk: Uint8Array) => {
  chunks.push(chunk);
};
const stdout = () => Buffer.concat(chunks).toString("utf8");

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
  chunks = [];
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

  it("ranks name matches before description-only matches", async () => {
    const tools = {
      tools: [
        { name: "TAGS_CREATE", description: "Create a tag for a task." },
        { name: "TASK_BOARD_ITEM_CREATE", description: "Create a card." },
        { name: "AUTOMATION_ADD", description: "Run on task events." },
        { name: "TASK_BOARD_ITEM_LIST", description: "List cards." },
        { name: "THREAD_GET", description: "Get one thread." },
      ],
    };
    await toolsCommand({
      dataDir: dir,
      subcommand: "list",
      arg: "Task",
      org: "my-org",
      fetch: respondWith(tools),
    });

    expect(out.map((line) => line.split("\t")[0])).toEqual([
      "TASK_BOARD_ITEM_CREATE",
      "TASK_BOARD_ITEM_LIST",
      "TAGS_CREATE",
      "AUTOMATION_ADD",
    ]);
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
    expect(stdout()).toBe('{"error":"Forbidden"}');
  });
});

describe("toolsCommand describe", () => {
  it("prints the tool's signature", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "describe",
      arg: "THREAD_LIST",
      org: "my-org",
      fetch: respondWith(TOOLS),
    });

    expect(code).toBe(0);
    expect(out).toEqual(["THREAD_LIST — List threads.\ninput: none"]);
  });

  it("prints the full tool object with --json", async () => {
    const code = await toolsCommand({
      dataDir: dir,
      subcommand: "describe",
      arg: "THREAD_LIST",
      org: "my-org",
      json: true,
      fetch: respondWith(TOOLS),
    });

    expect(code).toBe(0);
    expect(out).toEqual([JSON.stringify(TOOLS.tools[0], null, 2)]);
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

describe("formatToolSignature", () => {
  it("prints one line per field with type, requiredness and description", () => {
    expect(
      formatToolSignature({
        name: "TASK_BOARD_ITEM_UPDATE",
        description: "Update a card.\nMore detail.",
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          openWorldHint: true,
        },
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            body: {
              description: "Markdown body,\n  shown on the card.",
              anyOf: [{ type: "string", maxLength: 50 }, { type: "null" }],
            },
            assigneeId: { type: ["string", "null"] },
            status: { type: "string", enum: ["todo", "done"] },
            audience: {
              anyOf: [
                { type: "string", const: "human" },
                { type: "string", const: "internal" },
              ],
            },
            limit: { type: "integer", default: 20 },
            dueDate: { type: "string", format: "date-time" },
          },
          required: ["id", "limit", "audience"],
        },
      }),
    ).toBe(
      [
        "TASK_BOARD_ITEM_UPDATE — Update a card.",
        "annotations: destructiveHint",
        "input:",
        "  id (string, required)",
        "  body (string, optional|nullable) — Markdown body, shown on the card.",
        "  assigneeId (string, optional|nullable)",
        '  status ("todo"|"done", optional)',
        '  audience ("human"|"internal", required)',
        "  limit (integer, optional, default 20)",
        "  dueDate (string<date-time>, optional)",
      ].join("\n"),
    );
  });

  it("summarizes nested objects and arrays one level deep", () => {
    expect(
      formatToolSignature({
        name: "X",
        inputSchema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  note: { type: ["string", "null"] },
                  meta: {
                    type: "object",
                    properties: { deep: { type: "string" } },
                  },
                },
                required: ["id"],
              },
            },
            tags: { type: "array", items: { enum: ["a", "b"] } },
            marks: { type: "array", items: { enum: ['x|"}'] } },
            pair: {
              type: "array",
              prefixItems: [{ type: "string" }, { type: "number" }],
            },
            labels: {
              type: "object",
              additionalProperties: { type: "string" },
            },
            extra: { type: "object", additionalProperties: {} },
            choice: {
              oneOf: [
                {
                  type: "object",
                  properties: { kind: { const: "a" } },
                  required: ["kind"],
                },
                { type: "null" },
              ],
            },
            anything: {},
          },
          required: ["items"],
        },
      }),
    ).toBe(
      [
        "X",
        "input:",
        "  items ({ id: string, note?: string|null, meta?: object }[], required)",
        '  tags (("a"|"b")[], optional)',
        '  marks ("x|\\"}"[], optional)',
        "  pair ([string, number], optional)",
        "  labels ({ [key]: string }, optional)",
        "  extra (object, optional)",
        '  choice ({ kind: "a" }, optional|nullable)',
        "  anything (any, optional)",
      ].join("\n"),
    );
  });

  it("says when a tool takes no input", () => {
    for (const inputSchema of [
      undefined,
      {},
      { type: "object" },
      { type: "object", properties: {} },
    ]) {
      expect(formatToolSignature({ name: "PING", inputSchema })).toBe(
        "PING\ninput: none",
      );
    }
  });

  it("prints a union input on one line", () => {
    expect(
      formatToolSignature({
        name: "X",
        inputSchema: {
          oneOf: [
            {
              type: "object",
              properties: { id: { type: "string" } },
              required: ["id"],
            },
            {
              type: "object",
              properties: { slug: { type: "string" } },
              required: ["slug"],
            },
          ],
        },
      }),
    ).toBe("X\ninput: { id: string }|{ slug: string }");
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
    expect(stdout()).toBe('{"id":"t_1"}');
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

  it("uses the only session on disk, for a studio on a non-default port", async () => {
    const sandboxDir = await mkdtemp(join(tmpdir(), "deco-tools-port-"));
    try {
      await writeFile(
        join(sandboxDir, "session.studio.example.ts.net_10000.json"),
        JSON.stringify({
          target: "https://studio.example.ts.net:10000",
          clientId: "sandbox-run",
          user: { sub: "u_1" },
          accessToken: "studio_api_key",
          createdAt: "2026-05-04T00:00:00.000Z",
        }),
        { mode: 0o600 },
      );
      const code = await toolsCommand({
        dataDir: sandboxDir,
        subcommand: "call",
        arg: "THREAD_GET",
        org: "my-org",
        fetch: respondWith({}),
        output,
      });

      expect(code).toBe(0);
      expect(calls[0]!.url).toBe(
        "https://studio.example.ts.net:10000/api/my-org/tools/THREAD_GET",
      );
      expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(
        "Bearer studio_api_key",
      );
    } finally {
      await rm(sandboxDir, { recursive: true, force: true });
    }
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
    expect(JSON.parse(stdout())).toEqual({
      error: "Invalid input",
      issues: [],
    });
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
