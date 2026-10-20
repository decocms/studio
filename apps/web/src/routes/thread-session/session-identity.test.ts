import { describe, expect, test } from "bun:test";
import { resolveThreadSessionIdentity } from "./session-identity";

describe("resolveThreadSessionIdentity", () => {
  const fallbackKey = "5f0d0f3a-0000-4000-8000-000000000000";

  test("the legacy route's own thread is both the thread and the key", () => {
    expect(
      resolveThreadSessionIdentity({ routeThreadId: "thread-1", fallbackKey }),
    ).toEqual({ threadId: "thread-1", providerKey: "thread-1" });
  });

  test("a destination's ?thread= is both the thread and the key", () => {
    expect(
      resolveThreadSessionIdentity({ routeThreadId: "thread-2", fallbackKey }),
    ).toEqual({ threadId: "thread-2", providerKey: "thread-2" });
  });

  /**
   * INVERTED: a route naming no thread used to report the fallback id AS the
   * thread, so the workspace opened an SSE stream on
   * `/decopilot/threads/<fabricated-uuid>/stream` (404, one per visit) and
   * reported a `chat_opened` for a thread nobody had opened. The fallback is
   * provider identity only; the thread stays absent.
   */
  test("a route that names no thread keeps the fallback out of the thread id", () => {
    expect(
      resolveThreadSessionIdentity({ routeThreadId: null, fallbackKey }),
    ).toEqual({ threadId: null, providerKey: fallbackKey });
  });

  test("opening a thread changes the provider key, so the workspace remounts", () => {
    const before = resolveThreadSessionIdentity({
      routeThreadId: null,
      fallbackKey,
    });
    const after = resolveThreadSessionIdentity({
      routeThreadId: "thread-3",
      fallbackKey,
    });
    expect(before.providerKey).not.toBe(after.providerKey);
  });
});
