/**
 * Which runs a manual re-run clears out of the way.
 *
 * The re-run exists because a task already assigned to the Super Agent had no
 * way to start another run — dispatch fires only on the TRANSITION to
 * `super-agent`, so re-assigning it is a silent no-op. The cards that need it
 * are wedged behind a thread that will never finish, so "which threads does
 * this supersede" is the decision that has to be right: too narrow and the
 * wedged card stays wedged; too broad and it discards a real terminal state.
 */
import { describe, expect, test } from "bun:test";
import {
  mergeDeadlocked,
  mergeRetryExpired,
  threadsToSupersede,
} from "./rerun";

const thread = (threadId: string, status: string | null) => ({
  threadId,
  status,
});

describe("threadsToSupersede", () => {
  // The prod shape: a thread written `in_progress` whose run never started,
  // holding the card In Progress with nothing behind it.
  test("supersedes a thread still in progress", () => {
    expect(
      threadsToSupersede({ threads: [thread("t1", "in_progress")] }),
    ).toEqual(["t1"]);
  });

  // The other wedge: parked on a `user_ask` nobody will answer.
  test("supersedes a thread parked on requires_action", () => {
    expect(
      threadsToSupersede({ threads: [thread("t1", "requires_action")] }),
    ).toEqual(["t1"]);
  });

  test("leaves finished runs alone", () => {
    expect(
      threadsToSupersede({
        threads: [
          thread("done", "completed"),
          thread("broke", "failed"),
          thread("stale", "expired"),
        ],
      }),
    ).toEqual([]);
  });

  // An unresolved status is not evidence the run is live — don't fail it on a
  // guess.
  test("leaves a thread with an unknown status alone", () => {
    expect(threadsToSupersede({ threads: [thread("t1", null)] })).toEqual([]);
  });

  test("picks only the open runs out of a mixed set", () => {
    expect(
      threadsToSupersede({
        threads: [
          thread("old", "completed"),
          thread("wedged", "in_progress"),
          thread("failed", "failed"),
          thread("parked", "requires_action"),
        ],
      }),
    ).toEqual(["wedged", "parked"]);
  });

  // A task whose every run finished is the ordinary retry case — nothing to
  // take over, so the re-run is purely additive.
  test("a task with no open run supersedes nothing", () => {
    expect(threadsToSupersede({ threads: [] })).toEqual([]);
  });
});

/**
 * The half of `refuseIfMergePending` that is not "approved": whether a merge
 * can still happen at all. Refusing when it cannot deadlocked three prod cards
 * — an approved PR conflicting with its base, its conflict auto-resolution cap
 * spent, so every poll re-attempted the same merge and got the same 405, while
 * Re-run (the only escape) answered "its merge is retrying".
 */
describe("mergeDeadlocked", () => {
  const resolutions = (n: number) =>
    Array.from({ length: n }, () => ({
      action: "merge_conflict_resolution",
      occurredAt: "2026-08-13T18:28:00.000Z",
    }));

  test("is true only once a conflicting PR has spent the cap", () => {
    expect(mergeDeadlocked(true, resolutions(3))).toBe(true);
    expect(mergeDeadlocked(true, resolutions(2))).toBe(false);
  });

  test("is false for a PR that merges cleanly, however many resolutions it took", () => {
    expect(mergeDeadlocked(false, resolutions(3))).toBe(false);
  });

  test("is false when mergeability is unknown — never break a merge that may be real", () => {
    expect(mergeDeadlocked(null, resolutions(3))).toBe(false);
  });

  test("is false for a card that never conflicted at all", () => {
    expect(mergeDeadlocked(false, [])).toBe(false);
    expect(mergeDeadlocked(true, [])).toBe(false);
  });
});

/**
 * The bound on the same refusal, for every way a merge stays stuck that
 * `mergeDeadlocked` cannot see (a failing required check, branch protection, a
 * base branch that moved). Those still hit the refusal in prod after the
 * conflict fix shipped: approved, unmergeable, and un-re-runnable.
 */
describe("mergeRetryExpired", () => {
  const NOW = Date.parse("2026-08-13T18:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();
  const MINUTE = 60 * 1000;
  const inReview = (at: string) => ({
    action: "status_changed",
    data: { to: "in_review" },
    occurredAt: at,
  });
  const approved = (at: string) => ({
    action: "review_approved",
    data: { reviewer: "qa", verified: true },
    occurredAt: at,
  });

  test("protects a merge that is plausibly one sweep tick away", () => {
    expect(
      mergeRetryExpired(
        [inReview(ago(12 * MINUTE)), approved(ago(MINUTE))],
        NOW,
      ),
    ).toBe(false);
  });

  test("expires once the merge has had its sweep attempts and lost", () => {
    expect(
      mergeRetryExpired(
        [inReview(ago(30 * MINUTE)), approved(ago(20 * MINUTE))],
        NOW,
      ),
    ).toBe(true);
  });

  // An approval from a PREVIOUS cycle is not evidence this one is shipping.
  test("ignores approvals recorded before the current review cycle", () => {
    expect(
      mergeRetryExpired(
        [approved(ago(60 * MINUTE)), inReview(ago(MINUTE))],
        NOW,
      ),
    ).toBe(true);
  });

  // No approval to read at all (activity unreadable) — the human is here and
  // the machine has shown nothing, so the re-run wins.
  test("expires when there is no approval to read", () => {
    expect(mergeRetryExpired([], NOW)).toBe(true);
  });
});
