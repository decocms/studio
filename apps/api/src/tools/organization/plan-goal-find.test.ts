import { describe, expect, it } from "bun:test";
import {
  FindResultSchema,
  firstFinding,
  SuggestResultSchema,
} from "./plan-goal-find";

const candidate = (statement: string) => ({
  statement,
  quote: `Our focus for 2027: ${statement}`,
  source: { kind: "connection" as const, label: "Meetings" },
});

describe("firstFinding", () => {
  it("answers the single store goal with the first candidate", () => {
    const finding = firstFinding({
      candidates: [candidate("Grow the app."), candidate("Cut returns.")],
      read: ["MEMORY.md", "Meetings"],
      unread: ["deck.pdf"],
    });
    expect(finding).toEqual({
      found: candidate("Grow the app."),
      read: ["MEMORY.md", "Meetings"],
      unread: ["deck.pdf"],
    });
    expect(FindResultSchema.safeParse(finding).success).toBe(true);
  });

  it("keeps the reason when nothing was found", () => {
    for (const reason of ["not_found", "not_clear", "unavailable"] as const) {
      expect(
        firstFinding({ candidates: [], reason, read: [], unread: [] }),
      ).toEqual({ found: null, reason, read: [], unread: [] });
    }
  });

  it("reads an already listed goal as nothing found, a reason the old tool knows", () => {
    const finding = firstFinding({
      candidates: [],
      reason: "already_listed",
      read: ["okrs.md"],
      unread: [],
    });
    expect(finding.reason).toBe("not_found");
    expect(FindResultSchema.safeParse(finding).success).toBe(true);
  });
});

describe("SuggestResultSchema", () => {
  it("refuses more candidates than one search proposes", () => {
    const many = Array.from({ length: 7 }, (_, index) =>
      candidate(`Goal ${index}.`),
    );
    expect(
      SuggestResultSchema.safeParse({ candidates: many, read: [], unread: [] })
        .success,
    ).toBe(false);
    expect(
      SuggestResultSchema.safeParse({
        candidates: many.slice(0, 6),
        read: [],
        unread: [],
      }).success,
    ).toBe(true);
  });
});
