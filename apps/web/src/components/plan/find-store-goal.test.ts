import { describe, expect, it } from "bun:test";
import { findNotice } from "./find-store-goal.ts";

describe("findNotice", () => {
  it("shows the goal with the quote and where it was found", () => {
    expect(
      findNotice({
        found: {
          statement: "Make the app our main sales channel.",
          quote: "In 2027 the app becomes our main channel",
          source: { kind: "connection", label: "Grain" },
        },
        read: ["MEMORY.md", "Grain"],
        unread: [],
      }),
    ).toEqual({
      kind: "found",
      statement: "Make the app our main sales channel.",
      source: "Grain",
      quote: "In 2027 the app becomes our main channel",
    });
  });

  it("asks the person to write it when nothing clear was found", () => {
    for (const reason of ["not_found", "not_clear"] as const) {
      expect(
        findNotice({ found: null, reason, read: ["okrs.md"], unread: [] }),
      ).toEqual({
        kind: "missing",
        message: "plan.objective.notFound",
        read: ["okrs.md"],
        unread: [],
      });
    }
  });

  it("says the AI is unavailable instead of claiming there is no goal", () => {
    const notice = findNotice({
      found: null,
      reason: "unavailable",
      read: [],
      unread: ["deck.pdf"],
    });
    expect(notice).toEqual({
      kind: "missing",
      message: "plan.objective.findUnavailable",
      read: [],
      unread: ["deck.pdf"],
    });
  });
});
