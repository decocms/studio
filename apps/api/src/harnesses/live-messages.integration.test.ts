/**
 * Real-Postgres coverage for the Studio half of live messages: which messages
 * may go into a running claude-code turn, and what is stored when they cannot.
 * The daemon's half (delivery, the runner's ack, duplicates) is asserted
 * black-box in `packages/sandbox/daemon-e2e/daemon.dispatch.e2e.test.ts`.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import type { Thread } from "@/storage/types";
import {
  setThreadSandboxMapEntry,
  threadBranch,
} from "@/tools/sandbox/thread-repo";
import {
  buildThreadTestContext,
  type ThreadTestEnv,
} from "@/tools/thread/test-helpers";
import {
  daemonRunId,
  deliverLiveMessage,
  liveRunIdOf,
  liveRunSandbox,
} from "./live-messages";

type Message = {
  id: string;
  role: "user";
  parts: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

describe("live messages", () => {
  let env: ThreadTestEnv;
  let ctx: StudioContext;
  let thread: Thread;
  let agentId: string;
  let n = 0;

  beforeAll(async () => {
    env = await buildThreadTestContext();
    ctx = env.ctx;
    const agent = await ctx.storage.virtualMcps.create(env.orgId, env.userId, {
      title: "live-messages agent",
      connections: [],
      status: "active",
      pinned: false,
    });
    agentId = agent.id;
  });

  afterAll(async () => {
    await env.close();
  });

  /** A claude-code thread whose turn is running, as dispatch leaves it. */
  beforeEach(async () => {
    const created = await ctx.storage.threads.create({
      id: `thrd_live_${++n}`,
      organization_id: env.orgId,
      created_by: env.userId,
      virtual_mcp_id: agentId,
      harness_id: "claude-code",
      branch: null,
      status: "in_progress",
    });
    await ctx.storage.threads.setRunFence(created.id, "fence-1");
    thread = (await ctx.storage.threads.get(created.id)) as Thread;
  });

  const message = (overrides: Partial<Message> = {}): Message => ({
    id: `msg_${n}_${Math.random().toString(36).slice(2)}`,
    role: "user",
    parts: [{ type: "text", text: "also update the changelog" }],
    metadata: { created_at: new Date().toISOString() },
    ...overrides,
  });

  /** Persist through the real write path, recording what each write stored. */
  function persistence(threadId: string) {
    const emitter = new PartEmitter({
      storage: ctx.storage.threads.messageParts(),
      orgId: env.orgId,
      threadId,
      runId: threadId,
    });
    const written: Array<string | null> = [];
    return {
      written,
      persist: async (m: Message) => {
        written.push(liveRunIdOf(m.metadata));
        await emitter.emitRequestMessage(m);
      },
    };
  }

  async function storedRows(threadId: string, messageId: string) {
    return env.database.db
      .selectFrom("thread_message_parts")
      .select(["kind", "metadata"])
      .where("thread_id", "=", threadId)
      .where("message_id", "=", messageId)
      .execute();
  }

  const deliver = (
    m: Message,
    overrides: Partial<Parameters<typeof deliverLiveMessage<Message>>[0]> = {},
  ) => {
    const { persist, written } = persistence(thread.id);
    return deliverLiveMessage<Message>({
      ctx,
      organizationId: env.orgId,
      thread,
      harnessId: "claude-code",
      userId: env.userId,
      agentId,
      runBranch: threadBranch(thread.id),
      message: m,
      storedLiveRunId: undefined,
      persist,
      ...overrides,
    }).then((result) => ({ ...result, written }));
  };

  test("a run that cannot be reached falls back to the queue, stored once without a run", async () => {
    const m = message();
    const result = await deliver(m);
    expect(result.outcome).toBe("queue-persisted");
    // Written for the running turn first, then stripped when it refused.
    expect(result.written).toEqual([daemonRunId(thread.id, "fence-1"), null]);
    const rows = await storedRows(thread.id, m.id);
    expect(rows.map((row) => row.kind).sort()).toEqual(["finish", "text"]);
    const finish = rows.find((row) => row.kind === "finish");
    expect(liveRunIdOf(finish?.metadata)).toBeNull();
    expect(liveRunIdOf(result.message.metadata)).toBeNull();
  });

  test("a resent message that was queued stays queued", async () => {
    const m = message();
    const result = await deliver(m, { storedLiveRunId: null });
    expect(result.outcome).toBe("not-attempted");
    expect(result.written).toEqual([]);
  });

  test("a resent message goes to the run it was sent to, not the current one", async () => {
    await ctx.storage.threads.setRunFence(thread.id, "fence-2");
    const m = message();
    const result = await deliver(m, {
      storedLiveRunId: daemonRunId(thread.id, "fence-1"),
    });
    expect(result.written[0]).toBe(daemonRunId(thread.id, "fence-1"));
    expect(result.outcome).toBe("queue-persisted");
  });

  test("another organization's thread is never delivered into", async () => {
    const m = message();
    const result = await deliver(m, {
      thread: { ...thread, organization_id: "org_456" },
    });
    expect(result.outcome).toBe("not-attempted");
    expect(await storedRows(thread.id, m.id)).toEqual([]);
  });

  test("only the thread's creator delivers into its run", async () => {
    const result = await deliver(message(), { userId: "user_1" });
    expect(result.outcome).toBe("not-attempted");
  });

  test("a turn that is not running, or not claude-code, takes nothing", async () => {
    expect(
      (await deliver(message(), { thread: { ...thread, status: "completed" } }))
        .outcome,
    ).toBe("not-attempted");
    expect((await deliver(message(), { harnessId: "decopilot" })).outcome).toBe(
      "not-attempted",
    );
  });

  test("a message with an attachment, or no text, is queued whole", async () => {
    const withFile = message({
      parts: [
        { type: "text", text: "see this" },
        {
          type: "file",
          url: "https://example.com/a.png",
          mediaType: "image/png",
        },
      ],
    });
    expect((await deliver(withFile)).outcome).toBe("not-attempted");
    const blank = message({ parts: [{ type: "text", text: "   " }] });
    expect((await deliver(blank)).outcome).toBe("not-attempted");
    const oversized = message({
      parts: [{ type: "text", text: "x".repeat(32_001) }],
    });
    expect((await deliver(oversized)).outcome).toBe("not-attempted");
  });

  test("the run's sandbox is the one recorded for the thread", async () => {
    await setThreadSandboxMapEntry(
      ctx,
      thread.id,
      env.userId,
      threadBranch(thread.id),
      { sandboxHandle: "sbx-live-1", previewUrl: null },
    );
    expect(
      await liveRunSandbox(ctx, {
        threadId: thread.id,
        agentId,
        runBranch: threadBranch(thread.id),
      }),
    ).toBe("sbx-live-1");
    // An agent with no sandbox for this branch has nothing to deliver into.
    expect(
      await liveRunSandbox(ctx, {
        threadId: thread.id,
        agentId,
        runBranch: "some-other-branch",
      }),
    ).toBeNull();
  });
});
