/**
 * End-to-end test for the `web_search` async-research path.
 *
 * Wires the real `googleAdapter` (which uses the real
 * `gemini-interactions.ts` HTTP client) against an in-process Bun.serve
 * mock that mimics the Gemini Interactions API contract. The
 * `GEMINI_INTERACTIONS_URL` env override is what redirects the adapter
 * onto the mock; no monkey-patching of `fetch` involved.
 *
 * What we're proving:
 *
 *   1. Happy path — the tool completes, returns the report text, and
 *      the `async_research_jobs` row walks pending → polling →
 *      completed with non-zero attempts.
 *   2. Resume path — invoking the tool a second time with the same
 *      tool_call_id finds the row in 'completed' state and short-
 *      circuits, returning the cached preview instead of submitting
 *      a fresh interaction.
 *   3. Terminal failure — when the provider returns status='failed',
 *      the tool throws `AsyncResearchTerminalError` and the row is
 *      marked 'failed' with the upstream error captured.
 *
 * These three are the load-bearing properties for the self-host
 * customer report: the row in the DB is always the source of truth,
 * and the runtime never duplicates a paid provider job on replay.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "@/database/test-db";
import {
  OrgScopedAsyncResearchJobStorage,
  SqlAsyncResearchJobStorage,
} from "@/storage/async-research-jobs";
import { createTestSchema } from "@/storage/test-helpers";
import type { MeshContext } from "@/core/mesh-context";
import { googleAdapter } from "@/ai-providers/adapters/google";
import { AsyncResearchTerminalError } from "@/ai-providers/types";
import type { ModelInfo } from "@/api/routes/decopilot/types";
import type { UIMessageStreamWriter } from "ai";
import { createWebSearchTool } from "./web-search";

// ============================================================================
// Mock Gemini Interactions server — in-process, owns its own port.
// ============================================================================

interface MockServer {
  url: string;
  stop: () => Promise<void>;
  /** Per-interaction state machine, exposed so tests can assert poll counts. */
  interactions: Map<string, MockInteraction>;
}

interface MockInteraction {
  pollsLeft: number;
  terminal: "completed" | "failed";
  text: string;
  totalPolls: number;
}

interface SubmitOptions {
  pollsLeft: number;
  terminal: "completed" | "failed";
  text: string;
}

const REPORT_TEXT =
  "Mock research report. Detailed findings appear here in production runs.";

function startMockServer(defaults: SubmitOptions): MockServer {
  const interactions = new Map<string, MockInteraction>();

  const server = Bun.serve({
    port: 0, // OS picks a free port
    fetch(req: Request): Response {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/v1beta/interactions" && req.method === "POST") {
        const id = `int_mock_${crypto.randomUUID()}`;
        interactions.set(id, {
          pollsLeft: defaults.pollsLeft,
          terminal: defaults.terminal,
          text: defaults.text,
          totalPolls: 0,
        });
        return Response.json({ id });
      }

      if (path.startsWith("/v1beta/interactions/") && req.method === "GET") {
        const id = decodeURIComponent(
          path.slice("/v1beta/interactions/".length),
        );
        const state = interactions.get(id);
        if (!state) {
          return new Response("not found", { status: 404 });
        }
        state.totalPolls += 1;
        if (state.pollsLeft > 0) {
          state.pollsLeft -= 1;
          return Response.json({
            id,
            status: "in_progress",
            outputs: [
              {
                type: "thought_summary",
                text: "thinking",
                annotations: [],
              },
            ],
          });
        }
        if (state.terminal === "failed") {
          return Response.json({
            id,
            status: "failed",
            error: "mock terminal failure",
            outputs: [],
          });
        }
        return Response.json({
          id,
          status: "completed",
          outputs: [
            {
              type: "text",
              text: state.text,
              annotations: [
                {
                  type: "url_citation",
                  url: "https://example.test/citation",
                  title: "Example citation",
                },
              ],
            },
          ],
          usage: { input_tokens: 10, output_tokens: 42 },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://${server.hostname}:${server.port}/v1beta/interactions`,
    stop: () => Promise.resolve(server.stop()),
    interactions,
  };
}

// ============================================================================
// Test harness — minimal MeshContext, real storage, real google adapter
// ============================================================================

const ORG_ID = "org_e2e_async_research";
const USER_ID = "user_e2e_async_research";
const THREAD_ID = "thrd_e2e_async_research";

const DEEP_RESEARCH_MODEL: ModelInfo = {
  id: "deep-research-preview-mock",
  title: "Mock Deep Research",
  provider: "google",
};

function makeWriter(): {
  writer: UIMessageStreamWriter;
  events: Array<{ type: string; data?: unknown }>;
} {
  const events: Array<{ type: string; data?: unknown }> = [];
  const writer = {
    write: (part: { type: string; data?: unknown }) => {
      events.push(part);
    },
  } as unknown as UIMessageStreamWriter;
  return { writer, events };
}

function makeCtx(storage: OrgScopedAsyncResearchJobStorage): MeshContext {
  // The async path only reads `ctx.storage.asyncResearchJobs` and
  // `ctx.objectStorage`. Everything else can stay undefined behind the
  // unknown cast — this is a focused test, not an integration spec.
  return {
    storage: { asyncResearchJobs: storage },
    objectStorage: null,
  } as unknown as MeshContext;
}

// ============================================================================
// Suite
// ============================================================================

describe("web_search async-research e2e", () => {
  let database: TestDatabase;
  let storage: OrgScopedAsyncResearchJobStorage;
  let mock: MockServer;

  beforeAll(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);

    // FK parents for async_research_jobs (organization_id, thread_id via
    // the storage path; the storage doesn't actually constrain thread_id
    // at the DB level but threads-test patterns set them up so we mirror).
    const now = new Date().toISOString();
    await database.db
      .insertInto("organization")
      .values({
        id: ORG_ID,
        name: "E2E Org",
        slug: "e2e-async-research",
        createdAt: now,
      })
      .execute();
    await database.db
      .insertInto("user")
      .values({
        id: USER_ID,
        email: "e2e@async-research.test",
        emailVerified: 0,
        name: "E2E",
        createdAt: now,
        updatedAt: now,
      })
      .execute();
    await database.db
      .insertInto("threads")
      .values({
        id: THREAD_ID,
        organization_id: ORG_ID,
        title: "e2e",
        description: null,
        status: "in_progress",
        virtual_mcp_id: "",
        created_at: now,
        updated_at: now,
        created_by: USER_ID,
      })
      .execute();

    storage = new OrgScopedAsyncResearchJobStorage(
      new SqlAsyncResearchJobStorage(database.db),
      ORG_ID,
    );
  });

  afterAll(async () => {
    if (mock) await mock.stop();
    await closeTestDatabase(database);
    delete process.env.GEMINI_INTERACTIONS_URL;
  });

  it("walks pending → polling → completed and returns the report", async () => {
    mock = startMockServer({
      // First GET returns 'completed' immediately. The intra-poll loop
      // (in_progress → sleep → poll → completed) is covered by the
      // existing unit tests in gemini-interactions.test.ts; this test
      // is about the storage state machine on top of that.
      pollsLeft: 0,
      terminal: "completed",
      text: REPORT_TEXT,
    });
    process.env.GEMINI_INTERACTIONS_URL = mock.url;

    const provider = googleAdapter.create("test-api-key");
    const { writer, events } = makeWriter();
    const toolOutputMap = new Map<string, string>();
    const toolCallId = "tc_happy_path";

    const tool = createWebSearchTool(writer, {
      provider,
      deepResearchModelInfo: DEEP_RESEARCH_MODEL,
      ctx: makeCtx(storage),
      toolOutputMap,
      taskId: THREAD_ID,
    });

    // `tool({ execute })` from the AI SDK exposes the execute fn
    // directly on the returned object.
    const result = await (
      tool as unknown as {
        execute: (
          input: { query: string },
          opts: { toolCallId: string; abortSignal?: AbortSignal },
        ) => Promise<{
          success: boolean;
          content?: string;
          query: string;
          citations?: Array<{ url: string }>;
        }>;
      }
    ).execute({ query: "What is the answer?" }, { toolCallId });

    expect(result.success).toBe(true);
    expect(result.content).toContain(REPORT_TEXT);
    expect(result.citations?.[0]?.url).toBe("https://example.test/citation");
    expect(toolOutputMap.get(toolCallId)).toContain(REPORT_TEXT);

    // The mock saw exactly one submit + at least one poll.
    expect(mock.interactions.size).toBe(1);
    const interactionTotals = [...mock.interactions.values()][0]!.totalPolls;
    expect(interactionTotals).toBeGreaterThanOrEqual(1);

    // The DB row walked the full state machine.
    const row = await storage.findByToolCall(toolCallId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("completed");
    expect(row!.interactionId).toMatch(/^int_mock_/);
    expect(row!.attempts).toBeGreaterThanOrEqual(1);
    expect(row!.resultPreview).toContain(REPORT_TEXT);
    expect(row!.outputTokens).toBe(42);
    expect(row!.inputTokens).toBe(10);

    // We streamed progress + a final flush + tool metadata.
    const progressEvents = events.filter((e) => e.type === "data-web-search");
    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(events.some((e) => e.type === "data-tool-metadata")).toBe(true);

    // The stub assistant message was written at polling-start and
    // deleted on terminal — see the matching "mid-poll" test for the
    // intermediate state assertion.
    const stub = await database.db
      .selectFrom("thread_messages")
      .selectAll()
      .where("id", "=", `msg_async_stub_${toolCallId}`)
      .executeTakeFirst();
    expect(stub).toBeUndefined();
  });

  it("writes the seed stub message mid-poll and deletes it on completion", async () => {
    // Spin up a controllable mock whose first poll response is held
    // until the test signals it. That gives us a deterministic window
    // to inspect the DB while the tool is mid-flight — the entire
    // point of the stub (the AI SDK reader's seed on browser refresh
    // during the long polling window).
    let releasePoll!: () => void;
    const polled = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    let firstPollSeen = false;

    const server = Bun.serve({
      port: 0,
      async fetch(req): Promise<Response> {
        const url = new URL(req.url);
        if (url.pathname === "/v1beta/interactions" && req.method === "POST") {
          return Response.json({ id: "int_mock_held" });
        }
        if (
          url.pathname.startsWith("/v1beta/interactions/") &&
          req.method === "GET"
        ) {
          // Hold the first poll until the test inspects the stub,
          // then return `completed` so the run terminates promptly
          // (the default 5s inter-poll sleep would otherwise blow
          // through the test timeout).
          if (!firstPollSeen) {
            firstPollSeen = true;
            await polled;
          }
          return Response.json({
            id: "int_mock_held",
            status: "completed",
            outputs: [
              {
                type: "text",
                text: REPORT_TEXT,
                annotations: [],
              },
            ],
            usage: { input_tokens: 10, output_tokens: 42 },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    const heldUrl = `http://${server.hostname}:${server.port}/v1beta/interactions`;
    process.env.GEMINI_INTERACTIONS_URL = heldUrl;

    const toolCallId = "tc_mid_poll";
    try {
      const provider = googleAdapter.create("test-api-key");
      const { writer } = makeWriter();
      const toolOutputMap = new Map<string, string>();

      const tool = createWebSearchTool(writer, {
        provider,
        deepResearchModelInfo: DEEP_RESEARCH_MODEL,
        ctx: makeCtx(storage),
        toolOutputMap,
        taskId: THREAD_ID,
      });

      const execPromise = (
        tool as unknown as {
          execute: (
            input: { query: string },
            opts: { toolCallId: string },
          ) => Promise<{ success: boolean }>;
        }
      ).execute({ query: "Mid-poll stub check" }, { toolCallId });

      // Wait until the held poll has been hit — that tells us the
      // tool has reached the polling state and (by transactional
      // contract) the stub must already be in the DB.
      await new Promise<void>((resolve) => {
        const tick = () => {
          if (firstPollSeen) return resolve();
          setTimeout(tick, 10);
        };
        tick();
      });

      const stubMid = await database.db
        .selectFrom("thread_messages")
        .selectAll()
        .where("id", "=", `msg_async_stub_${toolCallId}`)
        .executeTakeFirst();
      expect(stubMid).toBeDefined();
      expect(stubMid!.role).toBe("assistant");
      expect(stubMid!.thread_id).toBe(THREAD_ID);
      const parts = JSON.parse(stubMid!.parts as unknown as string) as Array<{
        type: string;
        toolCallId: string;
        state: string;
        input: { query: string };
      }>;
      expect(parts).toHaveLength(1);
      expect(parts[0]?.type).toBe("tool-web_search");
      expect(parts[0]?.toolCallId).toBe(toolCallId);
      expect(parts[0]?.state).toBe("input-available");
      expect(parts[0]?.input.query).toBe("Mid-poll stub check");

      // Let the run finish.
      releasePoll();
      const result = await execPromise;
      expect(result.success).toBe(true);

      // Stub gone after terminal — same-transaction guarantee.
      const stubAfter = await database.db
        .selectFrom("thread_messages")
        .selectAll()
        .where("id", "=", `msg_async_stub_${toolCallId}`)
        .executeTakeFirst();
      expect(stubAfter).toBeUndefined();
    } finally {
      server.stop();
      process.env.GEMINI_INTERACTIONS_URL = mock.url;
    }
  });

  it("replays the cached result on a second invocation with the same tool_call_id", async () => {
    // Re-use the same mock; if the runtime mistakenly submitted a new
    // interaction, mock.interactions would grow.
    const sizeBefore = mock.interactions.size;

    const provider = googleAdapter.create("test-api-key");
    const { writer } = makeWriter();
    const toolOutputMap = new Map<string, string>();
    const toolCallId = "tc_happy_path"; // same as the previous test

    const tool = createWebSearchTool(writer, {
      provider,
      deepResearchModelInfo: DEEP_RESEARCH_MODEL,
      ctx: makeCtx(storage),
      toolOutputMap,
      taskId: THREAD_ID,
    });

    const result = await (
      tool as unknown as {
        execute: (
          input: { query: string },
          opts: { toolCallId: string },
        ) => Promise<{ success: boolean }>;
      }
    ).execute(
      { query: "Different query — should be ignored on replay" },
      { toolCallId },
    );

    expect(result.success).toBe(true);
    // No new provider job was submitted.
    expect(mock.interactions.size).toBe(sizeBefore);
  });

  it("marks the row 'failed' and surfaces a terminal error when the provider says so", async () => {
    // Spin up a dedicated mock that fails immediately so we don't
    // perturb the happy-path mock's state map.
    const failMock = startMockServer({
      pollsLeft: 0,
      terminal: "failed",
      text: "",
    });
    process.env.GEMINI_INTERACTIONS_URL = failMock.url;

    try {
      const provider = googleAdapter.create("test-api-key");
      const { writer } = makeWriter();
      const toolOutputMap = new Map<string, string>();
      const toolCallId = "tc_failure";

      const tool = createWebSearchTool(writer, {
        provider,
        deepResearchModelInfo: DEEP_RESEARCH_MODEL,
        ctx: makeCtx(storage),
        toolOutputMap,
        taskId: THREAD_ID,
      });

      let caught: unknown;
      try {
        await (
          tool as unknown as {
            execute: (
              input: { query: string },
              opts: { toolCallId: string },
            ) => Promise<unknown>;
          }
        ).execute({ query: "boom" }, { toolCallId });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(AsyncResearchTerminalError);

      const row = await storage.findByToolCall(toolCallId);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("failed");
      expect(row!.lastError).toContain("mock terminal failure");
      expect(row!.completedAt).not.toBeNull();
    } finally {
      await failMock.stop();
      // Restore happy-path mock url for any subsequent tests.
      process.env.GEMINI_INTERACTIONS_URL = mock.url;
    }
  });
});
