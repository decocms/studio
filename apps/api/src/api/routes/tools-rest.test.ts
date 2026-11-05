import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import type { StudioContext } from "@/core/studio-context";
import { TOOL_BY_NAME } from "@/tools";
import {
  resolveThreadToolNames,
  THREAD_TOOL_NAMES,
} from "@/tools/task-board/task-run-context";
import type { Env } from "../hono-env";
import { createToolsRestRoutes } from "./tools-rest";

const threads: Record<string, { title: string; virtual_mcp_id: string }> = {
  thrd_chat: { title: "Some chat", virtual_mcp_id: "vir_chat" },
  thrd_review: { title: "Reviewer: Add an H1", virtual_mcp_id: "vir_review" },
};

/**
 * Inert collaborators for `defineTool`'s wrapper; the thread lookup and the
 * interests write are what the assertions read.
 */
function app(auth: StudioContext["auth"]) {
  const interestWrites: string[] = [];
  const ctx = {
    organization: { id: "org_tools_rest", slug: "o", name: "O" },
    auth,
    access: { check: async () => {}, setToolName: () => {} },
    timings: {
      measure: async <T>(_n: string, cb: () => Promise<T>) => await cb(),
    },
    meter: {
      createHistogram: () => ({ record: () => {} }),
      createCounter: () => ({ add: () => {} }),
    },
    tracer: {
      startActiveSpan: (
        _n: string,
        _o: unknown,
        fn: (span: unknown) => unknown,
      ) =>
        fn({ setStatus: () => {}, recordException: () => {}, end: () => {} }),
    },
    db: {
      selectFrom: () => ({
        selectAll: () => ({
          where: () => ({
            where: () => ({ executeTakeFirst: async () => undefined }),
          }),
        }),
      }),
    },
    storage: {
      threads: { get: async (id: string) => threads[id] ?? null },
      interests: {
        setForAgent: async (_org: string, agentId: string) => {
          interestWrites.push(agentId);
        },
      },
    },
  } as unknown as StudioContext;
  const hono = new Hono<Env>();
  hono.use("*", async (c, next) => {
    c.set("studioContext", ctx);
    await next();
  });
  hono.route("/tools", createToolsRestRoutes());
  return { hono, interestWrites };
}

const user = { id: "user_1" };
const boundTo = (threadId: string): StudioContext["auth"] => ({
  user,
  boundThreadId: threadId,
});

const call = (hono: Hono<Env>, toolName: string, body: unknown) =>
  hono.request(`/tools/${toolName}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const interests = { interests: [{ title: "Ship", summary: "Ship it" }] };

async function listed(hono: Hono<Env>): Promise<string[]> {
  const res = await hono.request("/tools");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { tools: { name: string }[] };
  return body.tools.map((tool) => tool.name);
}

describe("tools REST for a thread-bound key", () => {
  it("runs a run-scoped tool against the key's own thread", async () => {
    const { hono, interestWrites } = app(boundTo("thrd_chat"));
    const res = await call(hono, "update_interests", interests);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, count: 1 });
    expect(interestWrites).toEqual(["vir_chat"]);
  });

  it("takes the thread from the key, never from the request", async () => {
    const { hono, interestWrites } = app(boundTo("thrd_chat"));
    const res = await hono.request(
      "/tools/update_interests?threadId=thrd_review",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-thread-id": "thrd_review",
        },
        body: JSON.stringify({ ...interests, threadId: "thrd_review" }),
      },
    );
    expect(res.status).toBe(200);
    expect(interestWrites).toEqual(["vir_chat"]);
  });

  it("refuses a tool outside the thread's surface", async () => {
    const chat = app(boundTo("thrd_chat")).hono;
    const res = await call(chat, "TASK_BOARD_REVIEW_DECISION", {});
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Unknown tool: TASK_BOARD_REVIEW_DECISION",
    });

    const review = app(boundTo("thrd_review")).hono;
    expect((await call(review, "update_interests", interests)).status).toBe(
      404,
    );
  });

  it("lists only the thread's surface", async () => {
    expect(await listed(app(boundTo("thrd_review")).hono)).toEqual([
      ...resolveThreadToolNames(threads.thrd_review),
    ]);
    const chat = await listed(app(boundTo("thrd_chat")).hono);
    expect(chat).toEqual([...THREAD_TOOL_NAMES]);
    expect(chat).not.toContain("TASK_BOARD_REVIEW_DECISION");
  });
});

describe("tools REST for any other caller", () => {
  it("lists every tool", async () => {
    expect(await listed(app({ user }).hono)).toEqual([...TOOL_BY_NAME.keys()]);
  });

  it("runs a tool with no thread context", async () => {
    const { hono, interestWrites } = app({ user });
    const res = await call(hono, "update_interests", interests);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain(
      "only available on a thread's MCP endpoint",
    );
    expect(interestWrites).toEqual([]);
  });

  it("does not refuse a tool a chat's surface leaves out", async () => {
    const res = await call(
      app({ user }).hono,
      "TASK_BOARD_REVIEW_DECISION",
      {},
    );
    expect(res.status).not.toBe(404);
  });
});
