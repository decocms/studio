import { describe, expect, it } from "bun:test";
import {
  allReviewersApproved,
  enabledReviewerKinds,
  isReviewerThreadTitle,
  MAX_REVIEW_BOUNCES,
  reviewBounceLimitReached,
  reviewCycleStart,
  reviewCycleVerdicts,
  SUPER_AGENT_ASSIGNEE_ID,
  type ReviewCycleActivity,
} from "./task-board";

describe("enabledReviewerKinds", () => {
  it("returns nothing for missing/empty flags", () => {
    expect(enabledReviewerKinds(null)).toEqual([]);
    expect(enabledReviewerKinds(undefined)).toEqual([]);
    expect(enabledReviewerKinds({})).toEqual([]);
  });

  it("returns only the reviewers whose flag is exactly true", () => {
    expect(
      enabledReviewerKinds({
        qa_agent_enabled: true,
        code_reviewer_enabled: false,
      }),
    ).toEqual(["qa"]);
    expect(
      enabledReviewerKinds({
        qa_agent_enabled: true,
        code_reviewer_enabled: true,
      }),
    ).toEqual(["qa", "code_review"]);
    // Truthy-but-not-`true` must not enable it (org flags are booleans).
    expect(enabledReviewerKinds({ qa_agent_enabled: "true" })).toEqual([]);
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
    expect(isReviewerThreadTitle("QA Agent: Fix", "qa")).toBe(true);
    expect(isReviewerThreadTitle("Code Reviewer: Fix", "code_review")).toBe(
      true,
    );
    expect(isReviewerThreadTitle("QA Agent: Fix", "code_review")).toBe(false);
    expect(isReviewerThreadTitle("Super Agent: Fix", "qa")).toBe(false);
    expect(isReviewerThreadTitle(null, "qa")).toBe(false);
  });
});

describe("reviewCycleStart", () => {
  it("is the latest in_review transition (0 when none)", () => {
    expect(reviewCycleStart([IN_REVIEW_1, IN_REVIEW_2])).toBe(
      new Date("2026-01-01T12:00:00Z").getTime(),
    );
    expect(reviewCycleStart([])).toBe(0);
  });
});

describe("reviewCycleVerdicts", () => {
  it("keeps the latest verdict per reviewer within the current cycle", () => {
    const v = reviewCycleVerdicts([
      IN_REVIEW_1,
      at("review_approved", { reviewer: "qa" }, "2026-01-01T10:05:00Z"),
      at(
        "review_changes_requested",
        { reviewer: "code_review" },
        "2026-01-01T10:06:00Z",
      ),
    ]);
    expect(v.get("qa")).toBe("approved");
    expect(v.get("code_review")).toBe("changes_requested");
  });

  it("ignores verdicts from a prior cycle (before the latest in_review)", () => {
    const v = reviewCycleVerdicts([
      IN_REVIEW_1,
      at("review_approved", { reviewer: "qa" }, "2026-01-01T10:05:00Z"),
      IN_REVIEW_2, // re-review — old approval is now stale
    ]);
    expect(v.get("qa")).toBeUndefined();
  });

  it("verifiedOnly drops unverified approvals but keeps verified ones", () => {
    const activity = [
      IN_REVIEW_1,
      at(
        "review_approved",
        { reviewer: "qa", verified: true },
        "2026-01-01T10:05:00Z",
      ),
      at(
        "review_approved",
        { reviewer: "code_review", verified: false },
        "2026-01-01T10:06:00Z",
      ),
    ];
    const strict = reviewCycleVerdicts(activity, { verifiedOnly: true });
    expect(strict.get("qa")).toBe("approved");
    expect(strict.get("code_review")).toBeUndefined();
    const loose = reviewCycleVerdicts(activity);
    expect(loose.get("code_review")).toBe("approved");
  });
});

describe("allReviewersApproved", () => {
  const base = [
    IN_REVIEW_1,
    at(
      "review_approved",
      { reviewer: "qa", verified: true },
      "2026-01-01T10:05:00Z",
    ),
  ];

  it("is false until every enabled reviewer approved", () => {
    expect(allReviewersApproved(base, ["qa", "code_review"])).toBe(false);
    expect(
      allReviewersApproved(
        [
          ...base,
          at(
            "review_approved",
            { reviewer: "code_review", verified: true },
            "2026-01-01T10:06:00Z",
          ),
        ],
        ["qa", "code_review"],
      ),
    ).toBe(true);
  });

  it("empty enabled → false (nothing has signed off)", () => {
    expect(allReviewersApproved(base, [])).toBe(false);
  });

  it("verifiedOnly gate: an unverified approval never completes the review (anti-forgery)", () => {
    const forged = [
      IN_REVIEW_1,
      at(
        "review_approved",
        { reviewer: "qa", verified: true },
        "2026-01-01T10:05:00Z",
      ),
      // Same agent forging the other reviewer without its token → unverified.
      at(
        "review_approved",
        { reviewer: "code_review", verified: false },
        "2026-01-01T10:06:00Z",
      ),
    ];
    expect(
      allReviewersApproved(forged, ["qa", "code_review"], {
        verifiedOnly: true,
      }),
    ).toBe(false);
    // The human ship button (no verifiedOnly) still sees both as approved.
    expect(allReviewersApproved(forged, ["qa", "code_review"])).toBe(true);
  });
});

// The runaway-loop guard. It counts ACROSS review cycles on purpose — each
// bounce starts a new cycle, so a per-cycle count is always 1 and would never
// trip, which is exactly how a board reached 179 change-requests.

function bounce(at: string, reviewer = "code_review"): ReviewCycleActivity {
  return {
    action: "review_changes_requested",
    data: { reviewer },
    occurredAt: at,
  };
}

function enteredReview(at: string): ReviewCycleActivity {
  return {
    action: "status_changed",
    data: { to: "in_review" },
    occurredAt: at,
  };
}

/**
 * `n` real bounces: a card enters In Review, a reviewer requests changes, the
 * card goes back and re-enters. A bare run of `review_changes_requested` rows
 * is NOT n bounces — the counter groups by cycle, because one dispatch can land
 * more than one verdict.
 */
function bounceCycles(n: number, fromHour = 0): ReviewCycleActivity[] {
  return Array.from({ length: n }, (_, i) => {
    const h = String(fromHour + i).padStart(2, "0");
    return [
      enteredReview(`2026-01-01T${h}:00:00.000Z`),
      bounce(`2026-01-01T${h}:30:00.000Z`),
    ];
  }).flat();
}

describe("reviewBounceLimitReached", () => {
  it("allows the first bounces through", () => {
    expect(reviewBounceLimitReached([])).toBe(false);
    expect(reviewBounceLimitReached(bounceCycles(3))).toBe(false);
  });

  it("trips on the bounce that would reach the limit, counting the pending one", () => {
    expect(reviewBounceLimitReached(bounceCycles(MAX_REVIEW_BOUNCES - 1))).toBe(
      true,
    );
  });

  // The claim fences the DISPATCH, not the decision, so a reviewer can land two
  // verdicts against one dispatch — only the first moves the card. Charging
  // both halved the real budget on three of four cards in one org.
  it("counts one bounce per cycle, however many verdicts land in it", () => {
    // The prod shape: two cycles, QA landing a duplicate verdict in each. Four
    // rows — which the old row-count read as four bounces and tripped on.
    const doubleCharged: ReviewCycleActivity[] = [
      enteredReview("2026-01-01T00:00:00.000Z"),
      bounce("2026-01-01T00:30:00.000Z", "qa"),
      bounce("2026-01-01T00:31:00.000Z", "qa"),
      enteredReview("2026-01-01T01:00:00.000Z"),
      bounce("2026-01-01T01:30:00.000Z", "qa"),
      bounce("2026-01-01T01:31:00.000Z", "qa"),
    ];
    expect(reviewBounceLimitReached(doubleCharged)).toBe(false);

    // Four REAL cycles still trip, on the same number of rows.
    expect(reviewBounceLimitReached(bounceCycles(4))).toBe(true);
  });

  it("counts bounces from earlier review cycles, not just the current one", () => {
    expect(reviewBounceLimitReached(bounceCycles(4))).toBe(true);
  });

  // The reset that makes a re-run mean something. Four cards carrying 5-7 old
  // bounces were re-delegated in prod and each was handed straight back on its
  // FIRST change-request — one review round, zero retries.
  it("counts only from the most recent hand-back to the Super Agent", () => {
    const burntOut = bounceCycles(6);
    expect(reviewBounceLimitReached(burntOut)).toBe(true);

    const reDelegated: ReviewCycleActivity[] = [
      ...burntOut,
      {
        action: "assignee_changed",
        data: { from: null, to: SUPER_AGENT_ASSIGNEE_ID },
        occurredAt: "2026-01-08T00:00:00.000Z",
      },
    ];
    expect(reviewBounceLimitReached(reDelegated)).toBe(false);
  });

  // ...and the loop still terminates: only a hand-back TO the Super Agent
  // resets, and the automatic hand-off writes `to: null`.
  it("is not reset by the automatic hand-off to a human", () => {
    expect(
      reviewBounceLimitReached([
        ...bounceCycles(4),
        {
          action: "assignee_changed",
          data: { from: SUPER_AGENT_ASSIGNEE_ID, to: null, reason: "burned" },
          occurredAt: "2026-01-01T05:00:00.000Z",
        },
      ]),
    ).toBe(true);
  });

  it("still trips within one delegation, after the reset", () => {
    const reDelegated: ReviewCycleActivity[] = [
      ...bounceCycles(2),
      {
        action: "assignee_changed",
        data: { from: null, to: SUPER_AGENT_ASSIGNEE_ID },
        occurredAt: "2026-01-01T05:00:00.000Z",
      },
      ...bounceCycles(MAX_REVIEW_BOUNCES - 1, 6),
    ];
    expect(reviewBounceLimitReached(reDelegated)).toBe(true);
  });

  it("ignores approvals and unrelated activity", () => {
    expect(
      reviewBounceLimitReached([
        {
          action: "review_approved",
          data: { reviewer: "qa" },
          occurredAt: "2026-01-01T00:00:00.000Z",
        },
        { action: "created", occurredAt: "2026-01-01T00:00:00.000Z" },
        bounce("2026-01-01T01:00:00.000Z"),
      ]),
    ).toBe(false);
  });
});
