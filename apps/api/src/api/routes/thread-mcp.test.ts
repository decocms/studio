import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { createThreadMcpRoutes, THREAD_MCP_PATHS } from "./thread-mcp";

const threads: Record<string, { title: string }> = {
  thrd_chat: { title: "Some chat" },
  thrd_review: { title: "Reviewer: Add an H1" },
};

function app() {
  const ctx = {
    storage: { threads: { get: async (id: string) => threads[id] ?? null } },
  } as unknown as StudioContext;
  const hono = new Hono<{ Variables: { studioContext: StudioContext } }>();
  hono.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  for (const path of THREAD_MCP_PATHS) {
    hono.route(path, createThreadMcpRoutes());
  }
  return hono;
}

function listTools(path: string, params: Record<string, unknown> = {}) {
  return app().request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params,
    }),
  });
}

async function toolNames(res: Response): Promise<string[]> {
  const body = (await res.json()) as {
    result: { tools: Array<{ name: string }> };
  };
  return body.result.tools.map((tool) => tool.name);
}

describe("thread MCP route", () => {
  // Keys minted before the rename still point at `task-run`.
  for (const path of ["/mcp/thread", "/mcp/task-run"]) {
    it(`serves a chat its surface at ${path}`, async () => {
      const res = await listTools(`${path}/thrd_chat`);
      expect(res.status).toBe(200);
      const names = await toolNames(res);
      expect(names).toContain("generate_image");
      expect(names).toContain("deep_research");
      expect(names).toContain("TASK_ADD_REPO");
      expect(names).not.toContain("TASK_BOARD_REVIEW_DECISION");
    });
  }

  it("serves a reviewer its own surface, from the thread", async () => {
    const names = await toolNames(await listTools("/mcp/thread/thrd_review"));
    expect(names).toContain("TASK_BOARD_REVIEW_DECISION");
    expect(names).not.toContain("generate_image");
  });

  // A JSON response carries no notifications, so progress needs a stream.
  it("answers a request that asks for progress over SSE", async () => {
    const res = await listTools("/mcp/thread/thrd_chat", {
      _meta: { progressToken: 7 },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toContain("generate_image");
  });

  it("keeps a plain JSON response when no progress was asked for", async () => {
    const res = await listTools("/mcp/thread/thrd_chat");
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("offers no standalone GET stream", async () => {
    const res = await app().request("/mcp/thread/thrd_chat", {
      headers: { accept: "text/event-stream" },
    });
    expect(res.status).toBe(405);
  });
});
