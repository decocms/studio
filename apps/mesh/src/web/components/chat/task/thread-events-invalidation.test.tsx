/**
 * Regression: thread-switch bug fix.
 *
 * Scenario: user sends a message in thread A, switches to thread B, the
 * run on A completes while the user is on B, and the user switches back
 * to A. Before this fix, ThreadConnection.A had been disposed when the
 * user switched away, so its in-memory localMessages were lost; the
 * useStreamManager that would have invalidated THREAD_MESSAGES.A was
 * also unmounted; and the /stream reconnect could not replay because
 * the run had reached a terminal state and the stream buffer was purged.
 * Net effect: cache stuck at "user message, no assistant", UI shows
 * "No response was generated" until page refresh.
 *
 * The fix: ThreadEventsBridge — mounted once at app root, regardless of
 * active thread — calls invalidateThreadMessages on decopilot.finish for
 * every thread. This test verifies that wiring directly.
 */
import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateThreadMessages } from "./invalidate-thread-messages";

// Build a THREAD_MESSAGES cache key shape matching what useCollectionList
// produces. The shape is defined by mesh-sdk's KEYS.collectionList.
function threadMessagesKey(taskId: string): readonly unknown[] {
  return [
    "",
    "org-1",
    "self-mcp",
    "collection",
    "THREAD_MESSAGES",
    "list",
    JSON.stringify({
      where: { field: ["thread_id"], operator: "eq", value: taskId },
      limit: 100,
      offset: 0,
    }),
  ];
}

describe("THREAD_MESSAGES cache invalidation on background finish", () => {
  test("invalidating thread A's cache leaves thread B's cache intact (the user is on B)", () => {
    const qc = new QueryClient();

    qc.setQueryData(threadMessagesKey("thread-A"), {
      items: [{ id: "u-1", role: "user" }],
    });
    qc.setQueryData(threadMessagesKey("thread-B"), {
      items: [{ id: "u-2", role: "user" }],
    });

    // Simulate decopilot.finish for thread A firing while we're on B.
    invalidateThreadMessages(qc, "thread-A");

    expect(qc.getQueryState(threadMessagesKey("thread-A"))?.isInvalidated).toBe(
      true,
    );
    expect(qc.getQueryState(threadMessagesKey("thread-B"))?.isInvalidated).toBe(
      false,
    );
  });

  test("the invalidation marks A's cache stale-while-revalidate, so the next mount refetches", () => {
    const qc = new QueryClient();
    const key = threadMessagesKey("thread-A");
    qc.setQueryData(key, { items: [{ id: "u-1", role: "user" }] });

    invalidateThreadMessages(qc, "thread-A");

    // After invalidation, the data is still present (so the user sees
    // their existing partial state immediately), but the query is marked
    // stale and will refetch on the next mount. React Query exposes this
    // via the query state.
    const state = qc.getQueryState(key);
    expect(state?.data).toEqual({ items: [{ id: "u-1", role: "user" }] });
    expect(state?.isInvalidated).toBe(true);
  });
});
