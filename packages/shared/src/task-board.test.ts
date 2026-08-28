import { describe, expect, it } from "bun:test";
import {
  allReviewersApproved,
  enabledReviewerKinds,
  isReviewerThreadTitle,
  outstandingReviewFeedback,
  reviewCycleStart,
  reviewCycleVerdicts,
  type ReviewCycleActivity,
} from "./task-board";

describe("enabledReviewerKinds", () => {
  it("enables the reviewer when flags are missing/empty (default-on)", () => {
    expect(enabledReviewerKinds(null)).toEqual(["reviewer"]);
    expect(enabledReviewerKinds(undefined)).toEqual(["reviewer"]);
    expect(enabledReviewerKinds({})).toEqual(["reviewer"]);
  });

  it("drops the reviewer only when its flag is exactly false", () => {
    expect(enabledReviewerKinds({ reviewer_enabled: false })).toEqual([]);
    expect(enabledReviewerKinds({ reviewer_enabled: true })).toEqual([
      "reviewer",
    ]);
  });

  it("carries over the two-reviewer opt-out: both off stays off", () => {
    expect(
      enabledReviewerKinds({
        qa_agent_enabled: false,
        code_reviewer_enabled: false,
      }),
    ).toEqual([]);
    // Only ONE of them off was still an org that wanted review.
    expect(enabledReviewerKinds({ qa_agent_enabled: false })).toEqual([
      "reviewer",
    ]);
    // An explicit `reviewer_enabled` always wins over the legacy pair.
    expect(
      enabledReviewerKinds({
        reviewer_enabled: true,
        qa_agent_enabled: false,
        code_reviewer_enabled: false,
      }),
    ).toEqual(["reviewer"]);
  });
});

const at = (
  action: string,
  data: Record<string, unknown>,
  occurredAt: string,
): ReviewCycleActivity => ({ action, data, occurredAt });

const IN_REVIEW_1 = at(
  "status_changed",
  { to: "in_review" },
  "2026-01-01T10:00:00Z",
);
const IN_REVIEW_2 = at(
  "status_changed",
  { to: "in_review" },
  "2026-01-01T12:00:00Z",
);

describe("isReviewerThreadTitle", () => {
  it("matches the reviewer's own thread by title prefix, not the Super Agent's", () => {
    expect(isReviewerThreadTitle("Reviewer: Fix", "reviewer")).toBe(true);
    expect(isReviewerThreadTitle("Super Agent: Fix", "reviewer")).toBe(false);
    expect(isReviewerThreadTitle(null, "reviewer")).toBe(false);
  });

  it("still matches an in-flight run from the two-reviewer era", () => {
    // Its title is the only thing that keeps it recognised — and being
    // recognised is what gets it the decision tool and stops a second dispatch.
    expect(isReviewerThreadTitle("QA Agent: Fix", "reviewer")).toBe(true);
    expect(isReviewerThreadTitle("Code Reviewer: Fix", "reviewer")).toBe(true);
  });
});

describe("reviewCycleStart", () => {
  // The column is the boundary since migration 189 — the lane transition is
  // only the fallback for cards stamped before it.
  it("is the card's own cycle stamp when it has one", () => {
    expect(
      reviewCycleStart([IN_REVIEW_1, IN_REVIEW_2], "2026-02-02T09:00:00Z"),
    ).toBe(new Date("2026-02-02T09:00:00Z").getTime());
    expect(reviewCycleStart([], "2026-02-02T09:00:00Z")).toBe(
      new Date("2026-02-02T09:00:00Z").getTime(),
    );
  });

  it("falls back to the latest in_review transition (0 when none)", () => {
    expect(reviewCycleStart([IN_REVIEW_1, IN_REVIEW_2], null)).toBe(
      new Date("2026-01-01T12:00:00Z").getTime(),
    );
    expect(reviewCycleStart([], null)).toBe(0);
  });
});

describe("reviewCycleVerdicts", () => {
  it("keeps the latest verdict within the current cycle", () => {
    const v = reviewCycleVerdicts(
      [
        IN_REVIEW_1,
        at("review_approved", { reviewer: "reviewer" }, "2026-01-01T10:05:00Z"),
        at(
          "review_changes_requested",
          { reviewer: "reviewer" },
          "2026-01-01T10:06:00Z",
        ),
      ],
      { cycleStartedAt: null },
    );
    expect(v.get("reviewer")).toBe("changes_requested");
  });

  it("ignores verdicts from a prior cycle (before the latest in_review)", () => {
    const v = reviewCycleVerdicts(
      [
        IN_REVIEW_1,
        at("review_approved", { reviewer: "reviewer" }, "2026-01-01T10:05:00Z"),
        IN_REVIEW_2, // re-review — old approval is now stale
      ],
      { cycleStartedAt: null },
    );
    expect(v.get("reviewer")).toBeUndefined();
  });

  it("ignores the two-reviewer era's verdicts — half a review is not a review", () => {
    const v = reviewCycleVerdicts(
      [
        IN_REVIEW_1,
        at(
          "review_approved",
          { reviewer: "qa", verified: true },
          "2026-01-01T10:05:00Z",
        ),
        at(
          "review_approved",
          { reviewer: "code_review", verified: true },
          "2026-01-01T10:06:00Z",
        ),
      ],
      { cycleStartedAt: null },
    );
    expect(v.size).toBe(0);
  });

  it("verifiedOnly drops an unverified approval but keeps a verified one", () => {
    const verified = [
      IN_REVIEW_1,
      at(
        "review_approved",
        { reviewer: "reviewer", verified: true },
        "2026-01-01T10:05:00Z",
      ),
    ];
    const unverified = [
      IN_REVIEW_1,
      at(
        "review_approved",
        { reviewer: "reviewer", verified: false },
        "2026-01-01T10:05:00Z",
      ),
    ];
    expect(
      reviewCycleVerdicts(verified, {
        cycleStartedAt: null,
        verifiedOnly: true,
      }).get("reviewer"),
    ).toBe("approved");
    expect(
      reviewCycleVerdicts(unverified, {
        cycleStartedAt: null,
        verifiedOnly: true,
      }).get("reviewer"),
    ).toBeUndefined();
    expect(
      reviewCycleVerdicts(unverified, { cycleStartedAt: null }).get("reviewer"),
    ).toBe("approved");
  });
});

describe("allReviewersApproved", () => {
  const approved = (verified: boolean) => [
    IN_REVIEW_1,
    at(
      "review_approved",
      { reviewer: "reviewer", verified },
      "2026-01-01T10:05:00Z",
    ),
  ];

  it("is false until the enabled reviewer approved", () => {
    expect(
      allReviewersApproved([IN_REVIEW_1], ["reviewer"], {
        cycleStartedAt: null,
      }),
    ).toBe(false);
    expect(
      allReviewersApproved(approved(true), ["reviewer"], {
        cycleStartedAt: null,
      }),
    ).toBe(true);
  });

  it("empty enabled → false (nothing has signed off)", () => {
    expect(
      allReviewersApproved(approved(true), [], { cycleStartedAt: null }),
    ).toBe(false);
  });

  it("verifiedOnly gate: an unverified approval never completes the review (anti-forgery)", () => {
    expect(
      allReviewersApproved(approved(false), ["reviewer"], {
        cycleStartedAt: null,
        verifiedOnly: true,
      }),
    ).toBe(false);
    // The human ship button (no verifiedOnly) still sees it as approved.
    expect(
      allReviewersApproved(approved(false), ["reviewer"], {
        cycleStartedAt: null,
      }),
    ).toBe(true);
  });
});

describe("outstandingReviewFeedback", () => {
  const changes = (
    occurredAt: string,
    notes: unknown = "fix the landmark",
  ) => ({
    action: "review_changes_requested",
    data: { reviewer: "reviewer", notes },
    occurredAt,
  });
  const approved = (occurredAt: string) => ({
    action: "review_approved",
    data: { reviewer: "reviewer", notes: "looks good" },
    occurredAt,
  });

  it("returns the notes when the latest verdict asked for changes", () => {
    expect(
      outstandingReviewFeedback([
        approved("2026-01-01T00:00:00.000Z"),
        changes("2026-01-01T01:00:00.000Z"),
      ]),
    ).toBe("fix the landmark");
  });

  it("returns null when the latest verdict is an approval", () => {
    expect(
      outstandingReviewFeedback([
        changes("2026-01-01T01:00:00.000Z"),
        approved("2026-01-01T02:00:00.000Z"),
      ]),
    ).toBeNull();
  });

  it("is ordered by time, not array position", () => {
    expect(
      outstandingReviewFeedback([
        changes("2026-01-01T03:00:00.000Z", "the newest ask"),
        approved("2026-01-01T02:00:00.000Z"),
        changes("2026-01-01T01:00:00.000Z", "an older ask"),
      ]),
    ).toBe("the newest ask");
  });

  // Two verdicts recorded in the same millisecond compare equal (the storage
  // row round-trips through a JS `Date`), so the append order decides. Getting
  // this backwards made the real-Postgres test flake, not fail.
  it("breaks a same-millisecond tie in favor of the later row", () => {
    const at = "2026-01-01T01:00:00.000Z";
    expect(outstandingReviewFeedback([approved(at), changes(at)])).toBe(
      "fix the landmark",
    );
    expect(outstandingReviewFeedback([changes(at), approved(at)])).toBeNull();
  });

  it("carries the latest ask across review cycles, unlike the cycle helpers", () => {
    expect(
      outstandingReviewFeedback([
        changes("2026-01-01T01:00:00.000Z"),
        {
          action: "status_changed",
          data: { to: "in_review" },
          occurredAt: "2026-01-01T02:00:00.000Z",
        },
      ]),
    ).toBe("fix the landmark");
  });

  it("returns null with no verdicts, or with non-string notes", () => {
    expect(outstandingReviewFeedback([])).toBeNull();
    expect(
      outstandingReviewFeedback([
        { action: "created", occurredAt: "2026-01-01T00:00:00.000Z" },
      ]),
    ).toBeNull();
    expect(
      outstandingReviewFeedback([changes("2026-01-01T01:00:00.000Z", null)]),
    ).toBeNull();
  });
});
