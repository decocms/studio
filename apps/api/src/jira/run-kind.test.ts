import { describe, expect, it } from "bun:test";
import { asJiraRunKind } from "./run-kind";

// The column was added after the rules were, and its default backfilled every
// existing row as `execute`. Anything else reaching this — a null from a read
// that predates the column, a value a future migration renames — must land on
// the behaviour those rules were written for, never on `review`: a rule that
// silently became a reviewer would stop implementing anything.
describe("asJiraRunKind", () => {
  it("reads `review` only from the exact value", () => {
    expect(asJiraRunKind("review")).toBe("review");
    expect(asJiraRunKind("Review")).toBe("execute");
    expect(asJiraRunKind("reviewer")).toBe("execute");
  });

  it("falls back to `execute` for anything unreadable", () => {
    expect(asJiraRunKind("execute")).toBe("execute");
    expect(asJiraRunKind(null)).toBe("execute");
    expect(asJiraRunKind(undefined)).toBe("execute");
    expect(asJiraRunKind("")).toBe("execute");
  });
});
