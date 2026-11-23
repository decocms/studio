import { describe, expect, it } from "bun:test";
import { PLAN_GOAL_SOURCE_LIMITS } from "@decocms/shared/plan-goals";
import { goalSource, keptSource, suggestionsNotice } from "./suggest-goals.ts";

describe("suggestionsNotice", () => {
  it("has nothing to say while there are goals to review", () => {
    expect(
      suggestionsNotice({
        candidates: [
          {
            statement: "Make the app our main sales channel.",
            quote: "In 2027 the app becomes our main channel",
            source: { kind: "connection", label: "Meetings" },
          },
        ],
        read: ["Meetings"],
        unread: [],
      }),
    ).toBeNull();
  });

  it("asks the person to write one when nothing clear was found", () => {
    for (const reason of ["not_found", "not_clear", undefined] as const) {
      expect(
        suggestionsNotice({
          candidates: [],
          reason,
          read: ["okrs.md"],
          unread: ["deck.pdf"],
        }),
      ).toEqual({
        kind: "missing",
        message: "plan.goals.suggest.notFound",
        read: ["okrs.md"],
        unread: ["deck.pdf"],
      });
    }
  });

  it("says the goals found are already listed instead of claiming there are none", () => {
    expect(
      suggestionsNotice({
        candidates: [],
        reason: "already_listed",
        read: ["okrs.md"],
        unread: [],
      })?.message,
    ).toBe("plan.goals.suggest.allListed");
  });

  it("says the AI is unavailable", () => {
    expect(
      suggestionsNotice({
        candidates: [],
        reason: "unavailable",
        read: [],
        unread: [],
      })?.message,
    ).toBe("plan.objective.findUnavailable");
  });
});

describe("goalSource", () => {
  it("keeps a source and quote within what a saved goal stores", () => {
    const source = goalSource(
      "x".repeat(PLAN_GOAL_SOURCE_LIMITS.label + 5),
      "y".repeat(PLAN_GOAL_SOURCE_LIMITS.quote + 5),
    );
    expect(source.label).toHaveLength(PLAN_GOAL_SOURCE_LIMITS.label);
    expect(source.quote).toHaveLength(PLAN_GOAL_SOURCE_LIMITS.quote);
    expect(goalSource("Meetings", "We aim for the app")).toEqual({
      label: "Meetings",
      quote: "We aim for the app",
    });
  });
});

describe("keptSource", () => {
  const source = { label: "Meetings", quote: "We aim for the app" };

  it("keeps where a suggestion was found while its sentence is unchanged", () => {
    expect(keptSource(source, "Grow the app.", " Grow the app. ")).toBe(source);
  });

  it("drops it once the person rewrites the sentence", () => {
    expect(keptSource(source, "Grow the app.", "Grow the app in 2027.")).toBe(
      null,
    );
    expect(keptSource(null, "Grow the app.", "Grow the app.")).toBeNull();
  });
});
