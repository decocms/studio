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
  assertHostedDecopilotHarness,
  assertPersistedHostedRuntime,
  assertHostedSandboxProvider,
  normalizeHostedSandboxProviderKind,
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
  const base = {
    messages: [
      {
        id: "user-123",
        role: "user" as const,
        parts: [{ type: "text", text: "hi" }],
      },
    ],
  };

  test("accepts the canonical request without routing selectors", () => {
    expect(StreamRequestSchema.safeParse(base).success).toBe(true);
  });

  test("accepts and strips the complete legacy routing envelope", () => {
    const result = StreamRequestSchema.parse({
      ...base,
      // This id deliberately need not match the thread: the compatibility
      // field is parsed only for shape validation and never becomes authority.
      agent: { id: "stale-agent", legacyExtra: true },
      harnessId: "decopilot",
      sandboxProviderKind: "cluster",
    });

    expect(result).not.toHaveProperty("agent");
    expect(result).not.toHaveProperty("harnessId");
    expect(result).not.toHaveProperty("sandboxProviderKind");
  });

  test("accepts only the known legacy Decopilot harness value", () => {
    expect(
      StreamRequestSchema.safeParse({ ...base, harnessId: "decopilot" })
        .success,
    ).toBe(true);
    for (const harnessId of ["claude-code", "codex", "opencode", "future"]) {
      expect(
        StreamRequestSchema.safeParse({ ...base, harnessId }).success,
      ).toBe(false);
    }
  });

  test("accepts only known legacy hosted sandbox values", () => {
    expect(
      StreamRequestSchema.safeParse({
        ...base,
        sandboxProviderKind: "agent-sandbox",
      }).success,
    ).toBe(true);
    expect(
      StreamRequestSchema.safeParse({
        ...base,
        sandboxProviderKind: "cluster",
      }).success,
    ).toBe(true);
    for (const sandboxProviderKind of ["user-desktop", "future-sandbox"]) {
      expect(
        StreamRequestSchema.safeParse({ ...base, sandboxProviderKind }).success,
      ).toBe(false);
    }
  });

  test("rejects malformed legacy agent envelopes", () => {
    for (const agent of [null, {}, { id: 42 }, "agent-123"]) {
      expect(StreamRequestSchema.safeParse({ ...base, agent }).success).toBe(
        false,
      );
    }
  });
});

describe("assertHostedDecopilotHarness", () => {
  test("allows only Decopilot or an unpinned hosted request", () => {
    expect(() => assertHostedDecopilotHarness("decopilot")).not.toThrow();
    expect(() => assertHostedDecopilotHarness(null)).not.toThrow();
    expect(() => assertHostedDecopilotHarness(undefined)).not.toThrow();
  });

  test("rejects persisted native, unknown, and future harness ids", () => {
    for (const harnessId of ["claude-code", "codex", "opencode", "future"]) {
      expect(() => assertHostedDecopilotHarness(harnessId)).toThrow(
        /Studio desktop app/,
      );
    }
  });
});

describe("assertHostedSandboxProvider", () => {
  test("allows managed or legacy-unpinned hosted sandboxes", () => {
    expect(() => assertHostedSandboxProvider("agent-sandbox")).not.toThrow();
    expect(() => assertHostedSandboxProvider(null)).not.toThrow();
    expect(() => assertHostedSandboxProvider(undefined)).not.toThrow();
  });

  test("rejects retired desktop and unknown sandbox ids", () => {
    for (const kind of ["user-desktop", "cluster", "future-sandbox"]) {
      expect(() => assertHostedSandboxProvider(kind)).toThrow(
        /unsupported desktop runtime/,
      );
    }
  });
});

describe("assertPersistedHostedRuntime", () => {
  test("allows current and legacy Decopilot rows", () => {
    expect(() =>
      assertPersistedHostedRuntime("decopilot", "agent-sandbox"),
    ).not.toThrow();
    expect(() => assertPersistedHostedRuntime("decopilot", null)).not.toThrow();
    expect(() =>
      assertPersistedHostedRuntime("decopilot", "user-desktop"),
    ).not.toThrow();
    expect(
      normalizeHostedSandboxProviderKind("decopilot", "user-desktop"),
    ).toBe("agent-sandbox");
  });

  test("rejects unpinned threads before a hosted control mutation", () => {
    expect(() => assertPersistedHostedRuntime(null, null)).toThrow(
      /has not started a hosted run/,
    );
  });

  test("rejects native runtime rows", () => {
    expect(() => assertPersistedHostedRuntime("codex", "user-desktop")).toThrow(
      /Studio desktop app/,
    );
    expect(() =>
      normalizeHostedSandboxProviderKind(null, "user-desktop"),
    ).toThrow(/unsupported desktop runtime/);
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
      requestedHarnessId: "decopilot",
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
      requestedHarnessId: "decopilot",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toBe(
      "decopilot.submit: ignored harness override on locked thread",
    );
    expect(warnSpy.mock.calls[0]?.[1]).toMatchObject({
      threadId: "thread-abc",
      requested: "decopilot",
      locked: "codex",
    });
  });

  test("locked thread: matching client harness does not trigger an audit warn", () => {
    applyThreadLock({
      taskIdInput: "thread-abc",
      thread: makeLockedThread({
        harness_id: "decopilot",
        sandbox_provider_kind: "agent-sandbox",
      }),
      requestedHarnessId: "decopilot",
      requestedSandboxProviderKind: "agent-sandbox",
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
      requestedHarnessId: "decopilot",
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
      requestedHarnessId: "decopilot",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("decopilot");
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
      requestedHarnessId: "decopilot",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: undefined,
    });

    expect(result.locked).toBe(false);
    // Without preferring the thread's branch, its first hosted turn would use
    // the synthetic "ephemeral" sandbox while continuations use the persisted
    // branch.
    expect(result.branch).toBe("rho-leonis");
  });

  test("no thread row (first message ever): client values flow through", () => {
    const result = applyThreadLock({
      taskIdInput: "thread-new",
      thread: null,
      requestedHarnessId: "decopilot",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("decopilot");
    expect(result.sandboxProviderKind).toBe("agent-sandbox");
    expect(result.branch).toBe("feature-x");
  });

  test("no taskIdInput (legacy callers): never touches the thread row", () => {
    const result = applyThreadLock({
      taskIdInput: undefined,
      thread: makeLockedThread(),
      requestedHarnessId: "decopilot",
      requestedSandboxProviderKind: "agent-sandbox",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("decopilot");
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

  test("only cancels the child when a hosted thread has a live fence", () => {
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
