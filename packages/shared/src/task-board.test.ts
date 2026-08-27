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
  it("enables both reviewers when flags are missing/empty (default-on)", () => {
    expect(enabledReviewerKinds(null)).toEqual(["qa", "code_review"]);
    expect(enabledReviewerKinds(undefined)).toEqual(["qa", "code_review"]);
    expect(enabledReviewerKinds({})).toEqual(["qa", "code_review"]);
  });

  it("drops a reviewer only when its flag is exactly false", () => {
    expect(
      enabledReviewerKinds({
        qa_agent_enabled: true,
        code_reviewer_enabled: false,
      }),
    ).toEqual(["qa"]);
    expect(
      enabledReviewerKinds({
        qa_agent_enabled: false,
        code_reviewer_enabled: false,
      }),
    ).toEqual([]);
    // An unset flag stays on; only an explicit `false` opts out.
    expect(enabledReviewerKinds({ qa_agent_enabled: false })).toEqual([
      "code_review",
    ]);
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

describe("outstandingReviewFeedback", () => {
  const changes = (
    occurredAt: string,
    notes: unknown = "fix the landmark",
  ) => ({
    action: "review_changes_requested",
    data: { reviewer: "qa", notes },
    occurredAt,
  });
  const approved = (occurredAt: string) => ({
    action: "review_approved",
    data: { reviewer: "code_review", notes: "looks good" },
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
