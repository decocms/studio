import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../lib/session";
import { printReply, sandboxCommand, toScript } from "./sandbox";

let dir: string;
let written: { stream: string; text: string }[];
let calls: { method: string; url: string; body?: string }[];
let errSpy: ReturnType<typeof spyOn>;
let logSpy: ReturnType<typeof spyOn>;
const write = (stream: "stdout" | "stderr", text: string) => {
  written.push({ stream, text });
};

function sse(...chunks: unknown[]): ReadableStream<Uint8Array> {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("");
  return new Response(`: keepalive\n\n${text}data: [DONE]\n\n`).body!;
}

function fakeFetch(routes: Record<string, () => Response>) {
  return (async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      url: url.pathname + url.search,
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const route = routes[`${method} ${url.pathname}`];
    return route ? route() : new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-sandbox-"));
  written = [];
  calls = [];
  errSpy = spyOn(console, "error").mockImplementation(() => {});
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  await writeSession(dir, {
    target: "https://studio.example.com",
    clientId: "client_abc",
    user: { sub: "u_1" },
    accessToken: "at_123",
    createdAt: "2026-05-04T00:00:00.000Z",
  });
});

afterEach(async () => {
  errSpy.mockRestore();
  logSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

describe("toScript", () => {
  it("runs a single argument as written", () => {
    expect(toScript(["cd app && ls -la"])).toBe("cd app && ls -la");
  });
  it("quotes argv words the remote shell would split or expand", () => {
    expect(toScript(["ls", "my dir", "$HOME", "it's", "a/b.ts"])).toBe(
      `ls 'my dir' '$HOME' 'it'\\''s' a/b.ts`,
    );
  });
});

describe("printReply", () => {
  it("prints text deltas and tool names until finish", async () => {
    const code = await printReply(
      sse(
        { type: "start" },
        { type: "text-delta", id: "t", delta: "hel" },
        { type: "tool-input-available", toolName: "Bash" },
        { type: "text-delta", id: "t", delta: "lo" },
        { type: "finish" },
        { type: "text-delta", id: "t", delta: "after finish" },
      ),
      write,
    );
    expect(code).toBe(0);
    expect(
      written.filter((w) => w.stream === "stdout").map((w) => w.text),
    ).toEqual(["hel", "lo", "\n"]);
    expect(written.some((w) => w.text.includes("[Bash]"))).toBe(true);
  });
  it("fails on an error chunk and on a stream that ends early", async () => {
    expect(
      await printReply(sse({ type: "error", errorText: "boom" }), write),
    ).toBe(1);
    expect(
      await printReply(sse({ type: "text-delta", delta: "x" }), write),
    ).toBe(1);
  });
});

describe("sandboxCommand", () => {
  const target = {
    virtualMcpId: "vmcp_1",
    branch: "thread:thrd_1/conn_1",
    sandboxHandle: "h",
    previewUrl: null,
  };

  it("exec addresses the chat's sandbox and returns the command's exit code", async () => {
    const fetch = fakeFetch({
      "POST /api/acme/tools/THREAD_SANDBOX_START": () => Response.json(target),
      "POST /api/acme/sandbox/vmcp_1/thread%3Athrd_1%2Fconn_1/bash": () =>
        Response.json({
          stdout: "out\n",
          stderr: "",
          exitCode: 3,
          timedOut: false,
        }),
    });
    const code = await sandboxCommand({
      dataDir: dir,
      fetch,
      write,
      subcommand: "exec",
      args: ["thrd_1", "git", "status"],
      org: "acme",
      timeout: 60,
    });
    expect(code).toBe(3);
    expect(written[0]).toEqual({ stream: "stdout", text: "out\n" });
    const bash = calls[1]!;
    expect(bash.url).toBe(
      "/api/acme/sandbox/vmcp_1/thread%3Athrd_1%2Fconn_1/bash?thread=thrd_1",
    );
    expect(JSON.parse(bash.body!)).toEqual({
      command: "git status",
      timeout: 60_000,
    });
  });

  it("exec remembers the address and falls back to a start when the sandbox is gone", async () => {
    let bashStatus = 200;
    const fetch = fakeFetch({
      "POST /api/acme/tools/THREAD_SANDBOX_START": () => Response.json(target),
      "POST /api/acme/sandbox/vmcp_1/thread%3Athrd_1%2Fconn_1/bash": () =>
        bashStatus === 200
          ? Response.json({
              stdout: "",
              stderr: "",
              exitCode: 0,
              timedOut: false,
            })
          : Response.json({ error: "sandbox not found" }, { status: 404 }),
    });
    const run = () =>
      sandboxCommand({
        dataDir: dir,
        fetch,
        write,
        subcommand: "exec",
        args: ["thrd_1", "true"],
        org: "acme",
      });
    const routes = () =>
      calls.map((c) => (c.url.includes("/tools/") ? "start" : "bash"));

    expect(await run()).toBe(0);
    expect(routes()).toEqual(["start", "bash"]);

    calls = [];
    expect(await run()).toBe(0);
    expect(routes()).toEqual(["bash"]);

    calls = [];
    bashStatus = 404;
    await run();
    expect(routes()).toEqual(["bash", "start", "bash"]);
  });

  it("exec reports a timeout with exit 124", async () => {
    const fetch = fakeFetch({
      "POST /api/acme/tools/THREAD_SANDBOX_START": () => Response.json(target),
      "POST /api/acme/sandbox/vmcp_1/thread%3Athrd_1%2Fconn_1/bash": () =>
        Response.json({ stdout: "", stderr: "", exitCode: -1, timedOut: true }),
    });
    const code = await sandboxCommand({
      dataDir: dir,
      fetch,
      write,
      subcommand: "exec",
      args: ["thrd_1", "sleep 999"],
      org: "acme",
    });
    expect(code).toBe(124);
  });

  it("chat opens the tail before posting and sends one user message", async () => {
    const fetch = fakeFetch({
      "POST /api/acme/tools/COLLECTION_THREADS_GET": () =>
        Response.json({ item: { id: "thrd_1", virtual_mcp_id: "vmcp_1" } }),
      "GET /api/acme/decopilot/threads/thrd_1/stream": () =>
        new Response(
          sse({ type: "text-delta", delta: "hi" }, { type: "finish" }),
        ),
      "POST /api/acme/decopilot/threads/thrd_1/messages": () =>
        Response.json({ delivery: "live" }, { status: 202 }),
    });
    const code = await sandboxCommand({
      dataDir: dir,
      fetch,
      write,
      subcommand: "chat",
      args: ["thrd_1", "say", "hi"],
      org: "acme",
    });
    expect(code).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "POST /api/acme/tools/COLLECTION_THREADS_GET",
      "GET /api/acme/decopilot/threads/thrd_1/stream",
      "POST /api/acme/decopilot/threads/thrd_1/messages",
    ]);
    const body = JSON.parse(calls[2]!.body!);
    expect(body.agent).toEqual({ id: "vmcp_1" });
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].parts).toEqual([{ type: "text", text: "say hi" }]);
  });

  it("new creates a sandbox chat on the org's default agent and boots it", async () => {
    const fetch = fakeFetch({
      "GET /api/_me/organizations": () =>
        Response.json({ organizations: [{ id: "org_1", slug: "acme" }] }),
      "POST /api/acme/tools/COLLECTION_THREADS_CREATE": () =>
        Response.json({ item: { id: "thrd_9" } }),
      "POST /api/acme/tools/THREAD_SANDBOX_START": () => Response.json(target),
    });
    const code = await sandboxCommand({
      dataDir: dir,
      fetch,
      write,
      subcommand: "new",
      args: [],
      org: "acme",
    });
    expect(code).toBe(0);
    expect(JSON.parse(calls[1]!.body!)).toEqual({
      data: { virtual_mcp_id: "decopilot_org_1", runtime: "sandbox" },
    });
    expect(JSON.parse(calls[2]!.body!)).toEqual({
      threadId: "thrd_9",
      wait: false,
    });
    expect(logSpy).toHaveBeenCalledWith("thrd_9");
  });

  it("surfaces a tool error and exits 1", async () => {
    const fetch = fakeFetch({
      "POST /api/acme/tools/THREAD_SANDBOX_START": () =>
        Response.json({ error: "Chat not found" }, { status: 400 }),
    });
    const code = await sandboxCommand({
      dataDir: dir,
      fetch,
      write,
      subcommand: "exec",
      args: ["nope", "ls"],
      org: "acme",
    });
    expect(code).toBe(1);
  });
});
