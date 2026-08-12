import { describe, expect, it } from "bun:test";
import {
  allReviewersApproved,
  isReviewerThreadTitle,
  MAX_REVIEW_BOUNCES,
  reviewBounceLimitReached,
  reviewCycleStart,
  reviewCycleVerdicts,
  SUPER_AGENT_ASSIGNEE_ID,
  type ReviewCycleActivity,
} from "./task-board";

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

function bounce(at: string): ReviewCycleActivity {
  return {
    action: "review_changes_requested",
    data: { reviewer: "code_review" },
    occurredAt: at,
  };
}

describe("reviewBounceLimitReached", () => {
  it("allows the first bounces through", () => {
    expect(reviewBounceLimitReached([])).toBe(false);
    expect(
      reviewBounceLimitReached([
        bounce("2026-01-01T00:00:00.000Z"),
        bounce("2026-01-01T01:00:00.000Z"),
        bounce("2026-01-01T02:00:00.000Z"),
      ]),
    ).toBe(false);
  });

  it("trips on the bounce that would reach the limit, counting the pending one", () => {
    const four = Array.from({ length: 4 }, (_, i) =>
      bounce(`2026-01-01T0${i}:00:00.000Z`),
    );
    expect(four).toHaveLength(MAX_REVIEW_BOUNCES - 1);
    expect(reviewBounceLimitReached(four)).toBe(true);
  });

  it("counts bounces from earlier review cycles, not just the current one", () => {
    const acrossCycles: ReviewCycleActivity[] = [
      bounce("2026-01-01T00:00:00.000Z"),
      {
        action: "status_changed",
        data: { to: "in_review" },
        occurredAt: "2026-01-01T00:30:00.000Z",
      },
      bounce("2026-01-01T01:00:00.000Z"),
      {
        action: "status_changed",
        data: { to: "in_review" },
        occurredAt: "2026-01-01T01:30:00.000Z",
      },
      bounce("2026-01-01T02:00:00.000Z"),
      {
        action: "status_changed",
        data: { to: "in_review" },
        occurredAt: "2026-01-01T02:30:00.000Z",
      },
      bounce("2026-01-01T03:00:00.000Z"),
    ];
    expect(reviewBounceLimitReached(acrossCycles)).toBe(true);
  });

  // The reset that makes a re-run mean something. Four cards carrying 5-7 old
  // bounces were re-delegated in prod and each was handed straight back on its
  // FIRST change-request — one review round, zero retries.
  it("counts only from the most recent hand-back to the Super Agent", () => {
    const burntOut = Array.from({ length: 6 }, (_, i) =>
      bounce(`2026-01-0${i + 1}T00:00:00.000Z`),
    );
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
    const four = Array.from({ length: 4 }, (_, i) =>
      bounce(`2026-01-01T0${i}:00:00.000Z`),
    );
    expect(
      reviewBounceLimitReached([
        ...four,
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
      bounce("2026-01-01T00:00:00.000Z"),
      bounce("2026-01-01T01:00:00.000Z"),
      {
        action: "assignee_changed",
        data: { from: null, to: SUPER_AGENT_ASSIGNEE_ID },
        occurredAt: "2026-01-02T00:00:00.000Z",
      },
      ...Array.from({ length: MAX_REVIEW_BOUNCES - 1 }, (_, i) =>
        bounce(`2026-01-02T0${i + 1}:00:00.000Z`),
      ),
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
