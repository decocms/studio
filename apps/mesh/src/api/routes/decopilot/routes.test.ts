/**
 * Unit tests for the pure helpers exported from ./routes.
 *
 * The POST /messages dispatch/link-gating behavior that used to live here was
 * a route handler with every dependency mocked (resolveTier, model-permissions,
 * dispatch-queue, the sandbox-kind resolver, and a fabricated StudioContext) —
 * the bad zone. It now runs through the real front door in
 * apps/mesh/e2e/tests/decopilot-messages.spec.ts. What remains is genuinely
 * pure: computeIdempotencyKey takes a message and returns a string, no I/O.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { applyThreadLock, computeIdempotencyKey } from "./routes";
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
      requestedSandboxProviderKind: "cluster",
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
      requestedSandboxProviderKind: "cluster",
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
      requestedSandboxProviderKind: "cluster",
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
      requestedSandboxProviderKind: "cluster",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("claude-code");
    expect(result.sandboxProviderKind).toBe("cluster");
    expect(result.branch).toBe("feature-x");
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("no thread row (first message ever): client values flow through", () => {
    const result = applyThreadLock({
      taskIdInput: "thread-new",
      thread: null,
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "cluster",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("claude-code");
    expect(result.sandboxProviderKind).toBe("cluster");
    expect(result.branch).toBe("feature-x");
  });

  test("no taskIdInput (legacy callers): never touches the thread row", () => {
    const result = applyThreadLock({
      taskIdInput: undefined,
      thread: makeLockedThread(),
      requestedHarnessId: "claude-code",
      requestedSandboxProviderKind: "cluster",
      requestedBranch: "feature-x",
    });

    expect(result.locked).toBe(false);
    expect(result.harnessId).toBe("claude-code");
    expect(result.sandboxProviderKind).toBe("cluster");
    expect(result.branch).toBe("feature-x");
  });
});
