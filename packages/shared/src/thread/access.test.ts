import { describe, expect, test } from "bun:test";
import { canRespondToThread } from "./access.ts";

describe("canRespondToThread", () => {
  test("owner can always respond, regardless of status", () => {
    for (const status of [
      "in_progress",
      "requires_action",
      "completed",
      "failed",
      "expired",
      null,
    ] as const) {
      expect(
        canRespondToThread({ createdBy: "u1", userId: "u1", status }),
      ).toBe(true);
    }
  });

  test("non-owner may respond when the thread awaits input (requires_action)", () => {
    expect(
      canRespondToThread({
        createdBy: "owner",
        userId: "teammate",
        status: "requires_action",
      }),
    ).toBe(true);
  });

  test("non-owner is read-only for every non-awaiting status", () => {
    for (const status of [
      "in_progress",
      "completed",
      "failed",
      "expired",
      null,
    ] as const) {
      expect(
        canRespondToThread({
          createdBy: "owner",
          userId: "teammate",
          status,
        }),
      ).toBe(false);
    }
  });

  test("permissive fallback when either id is missing", () => {
    expect(
      canRespondToThread({
        createdBy: undefined,
        userId: "teammate",
        status: "completed",
      }),
    ).toBe(true);
    expect(
      canRespondToThread({
        createdBy: "owner",
        userId: undefined,
        status: "completed",
      }),
    ).toBe(true);
  });

  test("empty-string ids are treated as unknown (permissive), not as owner", () => {
    // "" is falsy → the missing-id fallback, NOT a `"" === ""` owner match.
    // Guards against a future refactor that compares before the presence check.
    expect(
      canRespondToThread({ createdBy: "", userId: "", status: "completed" }),
    ).toBe(true);
    expect(
      canRespondToThread({
        createdBy: "",
        userId: "teammate",
        status: "completed",
      }),
    ).toBe(true);
  });
});
