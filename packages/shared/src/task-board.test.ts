import { describe, expect, it } from "bun:test";
import {
  allReviewersApproved,
  isReviewerThreadTitle,
  readyForAutoMerge,
  reviewCycleStart,
  reviewCycleVerdicts,
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

describe("readyForAutoMerge", () => {
  const qaApproved = [
    IN_REVIEW_1,
    at(
      "review_approved",
      { reviewer: "qa", verified: true },
      "2026-01-01T10:05:00Z",
    ),
  ];

  it("no reviewers enabled → ready (auto-merge with QA + Code Reviewer both off)", () => {
    // The gap this closes: with an empty enabled set, `allReviewersApproved` is
    // false, but auto-merge must still ship — nothing is standing in the way.
    expect(readyForAutoMerge([], [])).toBe(true);
    expect(readyForAutoMerge(qaApproved, [])).toBe(true);
  });

  it("with reviewers enabled, gates exactly like allReviewersApproved", () => {
    expect(readyForAutoMerge(qaApproved, ["qa"])).toBe(true);
    expect(readyForAutoMerge(qaApproved, ["qa", "code_review"])).toBe(false);
  });

  it("passes verifiedOnly through — an unverified approval doesn't count", () => {
    const forged = [
      IN_REVIEW_1,
      at(
        "review_approved",
        { reviewer: "qa", verified: false },
        "2026-01-01T10:05:00Z",
      ),
    ];
    expect(readyForAutoMerge(forged, ["qa"], { verifiedOnly: true })).toBe(
      false,
    );
    expect(readyForAutoMerge(forged, ["qa"])).toBe(true);
  });
});
