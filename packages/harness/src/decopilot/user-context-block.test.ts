import { describe, expect, test } from "bun:test";
import { renderUserContextBlock } from "./user-context-block";

const user = { name: "Ada", email: "ada@example.com" };

describe("renderUserContextBlock", () => {
  test("renders identity, history, and interests from passed-in data", () => {
    const out = renderUserContextBlock({
      user,
      currentThreadId: "t-current",
      userContext: {
        recentThreads: {
          total: 3,
          threads: [
            { id: "t1", title: "Old chat", updated_at: "2026-06-01T00:00:00Z" },
          ],
        },
        interests: [{ title: "Ship harness", summary: "extract pkg" }],
      },
    });
    expect(out).toContain("About this user");
    expect(out).toContain("Ada");
    expect(out).toContain("Old chat");
    expect(out).toContain("(2026-06-01)");
    expect(out).toContain("Ship harness");
  });

  test("returns null when there is no identity, history, or interests", () => {
    expect(renderUserContextBlock({ user: {}, userContext: {} })).toBeNull();
  });

  test("excludes the current thread from history and adjusts the total", () => {
    const out = renderUserContextBlock({
      user,
      currentThreadId: "t-current",
      userContext: {
        recentThreads: {
          total: 2,
          threads: [
            {
              id: "t-current",
              title: "This one",
              updated_at: "2026-06-02T00:00:00Z",
            },
            { id: "t1", title: "Other", updated_at: "2026-06-01T00:00:00Z" },
          ],
        },
      },
    });
    expect(out).toContain("Other");
    expect(out).not.toContain("This one");
    // total 2 minus the current thread → "1 previous conversation"
    expect(out).toContain("1 previous conversation");
  });

  test("caps injected interests at 3", () => {
    const out = renderUserContextBlock({
      user,
      userContext: {
        interests: [
          { title: "A", summary: "a" },
          { title: "B", summary: "b" },
          { title: "C", summary: "c" },
          { title: "D", summary: "d" },
        ],
      },
    });
    expect(out).toContain("- A: a");
    expect(out).toContain("- C: c");
    expect(out).not.toContain("- D: d");
  });
});
