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

  test("the default output, which is what Decopilot sends, is pinned byte for byte", () => {
    const out = renderUserContextBlock({
      user,
      currentThreadId: "t-current",
      userContext: {
        recentThreads: {
          total: 3,
          threads: [
            {
              id: "t-current",
              title: "This one",
              updated_at: "2026-06-02T00:00:00Z",
            },
            { id: "t1", title: "Old chat", updated_at: "2026-06-01T00:00:00Z" },
          ],
        },
        interests: [{ title: "Ship harness", summary: "extract pkg" }],
      },
    });
    expect(out).toBe(
      [
        "## About this user",
        "### Who you're talking to",
        "You're talking to Ada (ada@example.com). Address them by name when it's natural.",
        "### Your history together",
        "You and this user have had 2 previous conversations. Most recent:",
        '- "Old chat" (2026-06-01)',
        "Don't recap these unprompted, but use them so you recognize the user and pick up context naturally instead of treating them as a stranger.",
        "### What they're working toward",
        "Most important first:",
        "- Ship harness: extract pkg",
        "When the conversation is open-ended or clearly related, gently surface one concrete next step toward these. Do NOT derail a focused task the user is already on, and never force an interest in when it isn't relevant.",
        "When you learn a durable new goal the user is working toward — or clear progress on an existing one — call `update_interests` to keep this record current. Skip one-off questions.",
      ].join("\n\n"),
    );
    expect(
      renderUserContextBlock({ user, userContext: {}, whoOnly: false }),
    ).toBe(renderUserContextBlock({ user, userContext: {} }));
  });

  test("whoOnly keeps the person and drops history, interests and the update_interests line", () => {
    const out = renderUserContextBlock({
      user,
      whoOnly: true,
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
    expect(out).toBe(
      [
        "## About this user",
        "### Who you're talking to",
        "You're talking to Ada (ada@example.com). Address them by name when it's natural.",
      ].join("\n\n"),
    );
    expect(
      renderUserContextBlock({ user: {}, whoOnly: true, userContext: {} }),
    ).toBeNull();
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
