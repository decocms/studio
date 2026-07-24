/**
 * Unit tests for the pure helpers exported from ./routes.
 *
 * The POST /messages dispatch/link-gating behavior that used to live here was
 * a route handler with every dependency mocked (resolveTier, model-permissions,
 * dispatch-queue, the sandbox-kind resolver, and a fabricated StudioContext) —
 * the bad zone. It now runs through the real front door in
 * packages/e2e/tests/decopilot-messages.spec.ts. What remains is genuinely
 * pure: computeIdempotencyKey takes a message and returns a string, no I/O.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyThreadLock,
  computeIdempotencyKey,
  shouldPersistRequestMessage,
} from "./routes";
import { StreamRequestSchema } from "./schemas";
import type { ChatMessage } from "./types";
import type { Thread } from "@/storage/types";

describe("computeIdempotencyKey", () => {
  test("returns undefined for no message", () => {
    expect(computeIdempotencyKey(undefined)).toBeUndefined();
  });

  test("user turn: returns the message id verbatim", () => {
    const msg = {
      id: "user-123",
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(msg)).toBe("user-123");
  });

  test("assistant continuation: hashes the message contents", () => {
    const msg = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    const key = computeIdempotencyKey(msg);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  test("identical assistant messages produce the same hash (retry safety)", () => {
    const msg = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(msg)).toBe(computeIdempotencyKey(msg)!);
  });

  test("different approval states on the same message id produce different hashes", () => {
    // Regression: the previous implementation used `lastMsg.id` for both
    // branches, so two distinct approval rounds on the same assistant
    // message collapsed onto the first workflow and bricked the chat.
    const base = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    const next = {
      ...base,
      parts: [
        ...base.parts,
        {
          type: "tool-write",
          state: "approval-responded",
          approval: { id: "ap_2", approved: true },
        },
      ],
    } as unknown as ChatMessage;
    expect(computeIdempotencyKey(base)).not.toBe(computeIdempotencyKey(next));
  });

  test("user message without id falls back to content hash", () => {
    const msg = {
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    } as unknown as ChatMessage;
    const key = computeIdempotencyKey(msg);
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  test("key-order-canonical: same message with different key insertion order produces the SAME hash", () => {
    // Simulate two Objects built with different key-insertion order but
    // semantically identical content — as can happen between a fresh
    // round-trip serialization and the original runtime value.
    const msgA = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          type: "tool-bash",
          state: "approval-responded",
          approval: { id: "ap_1", approved: true },
        },
      ],
    } as unknown as ChatMessage;

    // msgB has the same data but keys inserted in reverse order inside `approval`.
    const msgB = {
      id: "msg_abc",
      role: "assistant",
      parts: [
        {
          // biome-ignore lint/suspicious/noExplicitAny: intentional key-order test
          ...(Object.fromEntries(
            Object.entries({
              state: "approval-responded",
              type: "tool-bash",
              approval: { approved: true, id: "ap_1" },
            }).reverse(),
          ) as any),
        },
      ],
    } as unknown as ChatMessage;

    expect(computeIdempotencyKey(msgA)).toBe(computeIdempotencyKey(msgB));
  });
});

describe("StreamRequestSchema", () => {
  test("normalizes legacy cluster sandboxProviderKind to agent-sandbox", () => {
    const result = StreamRequestSchema.parse({
      messages: [
        {
          id: "user-123",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        },
      ],
      agent: { id: "agent-123" },
      memory: { thread_id: "thread-123" },
      sandboxProviderKind: "cluster",
    });

    expect(result.sandboxProviderKind).toBe("agent-sandbox");
  });
});

describe("shouldPersistRequestMessage", () => {
  test("persists fresh user requests", () => {
    expect(
      shouldPersistRequestMessage({ alreadyPersisted: false, role: "user" }),
    ).toBe(true);
  });

  test("keeps the first persisted user request on retry", () => {
    expect(
      shouldPersistRequestMessage({ alreadyPersisted: true, role: "user" }),
    ).toBe(false);
  });

  test("replaces assistant continuation snapshots", () => {
    expect(
      shouldPersistRequestMessage({
        alreadyPersisted: true,
        role: "assistant",
      }),
    ).toBe(true);
  });
});

// ============================================================================
// applyThreadLock — the server-side enforcement point for the lock spec
// (docs/superpowers/specs/2026-06-03-lock-thread-harness-and-branch-design.md).
// Once a thread's `harness_id` is non-null the row wins over any
// client-supplied harness / sandbox / branch values.
// ============================================================================

function makeLockedThread(
  overrides: Partial<
    Pick<Thread, "harness_id" | "sandbox_provider_kind" | "branch">
  > = {},
): Pick<Thread, "harness_id" | "sandbox_provider_kind" | "branch"> {
  return {
    harness_id: "codex",
    sandbox_provider_kind: "user-desktop",
    branch: "main",
    ...overrides,
  };
}

describe("applyThreadLock", () => {
  let warnSpy: ReturnType<typeof mock>;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    originalWarn = console.warn;
    warnSpy = mock(() => {});
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("locked thread: row beats client overrides for harness, sandbox, and branch", () => {
    const result = applyThreadLock({
      taskIdInput: "thread-abc",
      thread: makeLockedThread(),
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(true);
    expect(result.harnessId).toBe("codex");
    expect(result.sandboxProviderKind).toBe("user-desktop");
    expect(result.branch).toBe("main");
  });

  test("locked thread: drifting client harness triggers a console.warn audit", () => {
    applyThreadLock({
      taskIdInput: "thread-abc",
      thread: makeLockedThread(),
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      "decopilot.submit: ignored harness override on locked thread",
    );
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      threadId: "thread-abc",
      requested: "claude-code",
      locked: "codex",
    });
  });

  test("locked thread: matching client harness does not trigger an audit warn", () => {
    applyThreadLock({
      taskIdInput: "thread-abc",
      thread: makeLockedThread(),
      requestedHarnessId: "codex",
      requestedSandboxProviderKind: "user-desktop",
      requestedBranch: "main",
    });

    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("locked thread with null sandbox/branch: row's nulls win, not client values", () => {
    const result = applyThreadLock({
      taskIdInput: "thread-abc",
      thread: makeLockedThread({
        sandbox_provider_kind: null,
        branch: null,
      }),
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(true);
    expect(result.harnessId).toBe("codex");
    expect(result.sandboxProviderKind).toBeUndefined();
    expect(result.branch).toBeNull();
  });

  test("unlocked thread (harness_id=null): client values flow through", () => {
    const result = applyThreadLock({
      taskIdInput: "thread-abc",
      thread: { harness_id: null, sandbox_provider_kind: null, branch: null },
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("claude-code");
    expect(result.sandboxProviderKind).toBe("agent-sandbox");
    expect(result.branch).toBe("feature-x");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("unlocked thread with a pinned branch (first message on a COLLECTION_THREADS_CREATE'd thread): the thread's branch wins over an absent request branch", () => {
    // The thread row already carries a branch assigned at creation, but
    // harness_id is still null because THIS is the first message (the pin
    // write happens alongside dispatch). The first POST commonly omits an
    // explicit branch.
    const result = applyThreadLock({
      taskIdInput: "thread-abc",
      thread: {
        harness_id: null,
        sandbox_provider_kind: null,
        branch: "rho-leonis",
      },
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "user-desktop",
      requestedBranch: undefined,
    });

    expect(result.locked).toBe(false);
    // Regression guard for the claude-code resume session-split: without
    // preferring the thread's branch here, the first turn resolved to a null
    // branch and dispatched against the synthetic "ephemeral" sandbox, while
    // continuations (now locked) used the thread's branch — so the claude
    // session created on turn 1 lived in a different sandbox than the one
    // `claude --resume` ran in on turn 2 ("No conversation found").
    expect(result.branch).toBe("rho-leonis");
  });

  test("no thread row (first message ever): client values flow through", () => {
    const result = applyThreadLock({
      taskIdInput: "thread-new",
      thread: null,
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("claude-code");
    expect(result.sandboxProviderKind).toBe("agent-sandbox");
    expect(result.branch).toBe("feature-x");
  });

  test("no taskIdInput (legacy callers): never touches the thread row", () => {
    const result = applyThreadLock({
      taskIdInput: undefined,
      thread: makeLockedThread(),
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("claude-code");
    expect(result.sandboxProviderKind).toBe("agent-sandbox");
    expect(result.branch).toBe("feature-x");
  });
});

// unified-control-plane T7: Stop must also tear down the detached hosted
// child (see hosted-harness-workflow.ts's `startHostedHarness` doc comment —
// since T3, the gate starts the child and does NOT await it, so a Stop that
// only cancelled the gate head left the child running as a wasted-but-inert
// background burn). `cancelActiveThreadRun` is a route-layer closure over
// live StudioContext/DBOS/NATS dependencies (DB reads, `DBOS.cancelWorkflow`
// via `cancelHostedHarness`, cross-pod broadcast) — exercising it end-to-end
// needs a launched DBOS + Postgres instance (repo policy: no mock fortress),
// so — same technique as thread-gate-workflow.test.ts's step-ordering
// regressions and hosted-harness-workflow.test.ts's `hostedChildWorkflowId`
// regression — this reads the real function body directly instead of a
// stand-in.
describe("cancelActiveThreadRun (T7: stop cancels the detached hosted child)", () => {
  const src = readFileSync(join(import.meta.dir, "routes.ts"), "utf8");
  const fnStart = src.indexOf("async function cancelActiveThreadRun(args: {");
  const fnEnd = src.indexOf(
    '\n  app.post("/:org/decopilot/cancel/:threadId"',
    fnStart,
  );
  const body = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);

  test("locates the function", () => {
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
  });

  test("imports cancelHostedHarness through the dispatch-queue barrel — the same single source of truth startHostedHarness uses, not a reconstructed id", () => {
    expect(src).toContain(
      'import { cancelHostedHarness, enqueueThreadRun } from "@/dispatch-queue";',
    );
  });

  test("reads the thread's CURRENT fence before cancelling the child (not a stale/cached one)", () => {
    const fenceReadIdx = body.indexOf(
      "await ctx.storage.threads.getRunFence(taskId)",
    );
    expect(fenceReadIdx).toBeGreaterThan(-1);
  });

  test("only cancels the child when a live fence exists — desktop runs (no hosted child) and threads that never dispatched are a no-op", () => {
    const fenceReadIdx = body.indexOf(
      "cancelFenceToken = await ctx.storage.threads.getRunFence(taskId);",
    );
    const guardIdx = body.indexOf("if (cancelFenceToken) {", fenceReadIdx);
    const cancelCallIdx = body.indexOf(
      "await cancelHostedHarness(taskId, cancelFenceToken);",
      guardIdx,
    );
    expect(fenceReadIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeGreaterThan(fenceReadIdx);
    expect(cancelCallIdx).toBeGreaterThan(guardIdx);
  });

  test("best-effort: the DBOS cancel is wrapped in try/catch so an unknown/already-terminal child (or any DBOS hiccup) can never fail the user-facing Stop", () => {
    const fenceReadIdx = body.indexOf(
      "cancelFenceToken = await ctx.storage.threads.getRunFence(taskId);",
    );
    const tryIdx = body.lastIndexOf("try {", fenceReadIdx);
    const catchIdx = body.indexOf("} catch (err) {", fenceReadIdx);
    expect(tryIdx).toBeGreaterThan(-1);
    expect(catchIdx).toBeGreaterThan(fenceReadIdx);
    // The catch logs (not rethrows) — grep the slice for a rethrow between
    // the catch and its close to make sure it stays a swallow-and-log.
    const catchBody = body.slice(catchIdx, body.indexOf("\n    }", catchIdx));
    expect(catchBody).not.toContain("throw ");
  });

  test("the hosted-child cancel runs AFTER the gate-head cancel (freeing the DBOS queue partition before touching the child)", () => {
    const gateHeadCancelIdx = body.indexOf("await cancelThreadGateHead(");
    const hostedCancelIdx = body.indexOf("await cancelHostedHarness(");
    expect(gateHeadCancelIdx).toBeGreaterThan(-1);
    expect(hostedCancelIdx).toBeGreaterThan(gateHeadCancelIdx);
  });
});
