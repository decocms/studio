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
import { threadsToSupersede } from "./rerun";

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
