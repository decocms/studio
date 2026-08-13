import { describe, expect, it } from "bun:test";
import type { ReviewCycleActivity } from "@decocms/shared/task-board";
import {
  isDuplicateChangeRequest,
  reviewTokenVerified,
} from "./review-decision";

describe("reviewTokenVerified", () => {
  const cycleA = new Date("2026-01-01T00:00:00Z").getTime();
  const cycleB = new Date("2026-01-02T00:00:00Z").getTime();

  it("verifies a claim for the right reviewer on the current cycle", () => {
    const claim = { reviewer: "qa", cycleAt: new Date(cycleA) };
    expect(reviewTokenVerified(claim, "qa", cycleA)).toBe(true);
  });

  it("rejects a claim whose reviewer doesn't match", () => {
    const claim = { reviewer: "qa", cycleAt: new Date(cycleA) };
    expect(reviewTokenVerified(claim, "code_review", cycleA)).toBe(false);
  });

  it("rejects a stale token from an earlier review cycle", () => {
    const claim = { reviewer: "qa", cycleAt: new Date(cycleA) };
    expect(reviewTokenVerified(claim, "qa", cycleB)).toBe(false);
  });

  it("rejects a missing claim", () => {
    expect(reviewTokenVerified(null, "qa", cycleA)).toBe(false);
  });
});

describe("isDuplicateChangeRequest", () => {
  const cycle = (at: string): ReviewCycleActivity => ({
    action: "status_changed",
    data: { to: "in_review" },
    occurredAt: at,
  });
  const changes = (reviewer: string, at: string): ReviewCycleActivity => ({
    action: "review_changes_requested",
    data: { reviewer },
    occurredAt: at,
  });

  it("is true for the same reviewer twice in one cycle", () => {
    const history = [
      cycle("2026-08-13T02:39:20Z"),
      changes("qa", "2026-08-13T02:54:59Z"),
    ];
    expect(isDuplicateChangeRequest(history, "qa")).toBe(true);
  });

  it("is false for the other reviewer's first verdict", () => {
    const history = [
      cycle("2026-08-13T02:39:20Z"),
      changes("qa", "2026-08-13T02:54:59Z"),
    ];
    expect(isDuplicateChangeRequest(history, "code_review")).toBe(false);
  });

  it("is false once the card came back for a fresh cycle", () => {
    const history = [
      cycle("2026-08-13T02:39:20Z"),
      changes("qa", "2026-08-13T02:54:59Z"),
      cycle("2026-08-13T02:55:21Z"),
    ];
    expect(isDuplicateChangeRequest(history, "qa")).toBe(false);
  });

  it("is false when this cycle's only verdict was an approval", () => {
    const history = [
      cycle("2026-08-13T02:39:20Z"),
      {
        action: "review_approved",
        data: { reviewer: "qa", verified: true },
        occurredAt: "2026-08-13T02:44:00Z",
      } as ReviewCycleActivity,
    ];
    expect(isDuplicateChangeRequest(history, "qa")).toBe(false);
  });
});
