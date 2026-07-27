import { describe, expect, test } from "bun:test";
import { classifyStall } from "./stall-recovery";

const thread = (status: string | null) => ({ status, hasPreview: false });

describe("classifyStall", () => {
  test("all threads terminal, newest completed → advance", () => {
    expect(
      classifyStall({
        status: "in_progress",
        threads: [thread("completed"), thread("failed")],
      }),
    ).toBe("advance");
  });

  test("newest failed → nudge, even when an older run completed", () => {
    expect(
      classifyStall({
        status: "in_progress",
        threads: [thread("failed"), thread("completed")],
      }),
    ).toBe("nudge");
  });

  test("a thread parked on user_ask is a human's problem, not ours", () => {
    expect(
      classifyStall({
        status: "in_progress",
        threads: [thread("requires_action"), thread("completed")],
      }),
    ).toBe("none");
  });

  test("a live run is left alone", () => {
    expect(
      classifyStall({
        status: "in_progress",
        threads: [thread("in_progress")],
      }),
    ).toBe("none");
  });

  // The 18 In Progress cards in prod with no linked thread are humans working.
  test("no linked thread → never touched", () => {
    expect(classifyStall({ status: "in_progress", threads: [] })).toBe("none");
  });

  test("only In Progress cards stall", () => {
    for (const status of ["triage", "todo", "in_review", "done"] as const) {
      expect(classifyStall({ status, threads: [thread("completed")] })).toBe(
        "none",
      );
    }
  });
});
