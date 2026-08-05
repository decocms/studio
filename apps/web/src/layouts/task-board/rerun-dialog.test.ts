/**
 * Whether the re-run confirmation warns about superseding a live run.
 *
 * Mirrors the API's `threadsToSupersede` over the board's own thread refs. The
 * duplication is deliberate — `apps/web` must not import from `apps/api/src`,
 * and the two drifting apart would mean the dialog promises something the tool
 * does not do, which is a wire-contract regression worth failing on.
 */
import { describe, expect, test } from "bun:test";
import { hasUnfinishedRun } from "./rerun-dialog";

type Item = Parameters<typeof hasUnfinishedRun>[0];

const itemWith = (statuses: (string | null)[]) =>
  ({
    threads: statuses.map((status, i) => ({ threadId: `t${i}`, status })),
  }) as Item;

describe("hasUnfinishedRun", () => {
  test("an in-progress run means the re-run takes over", () => {
    expect(hasUnfinishedRun(itemWith(["in_progress"]))).toBe(true);
  });

  test("a run parked on requires_action also gets taken over", () => {
    expect(hasUnfinishedRun(itemWith(["requires_action"]))).toBe(true);
  });

  test("finished runs need no warning", () => {
    expect(hasUnfinishedRun(itemWith(["completed", "failed", "expired"]))).toBe(
      false,
    );
  });

  test("an unresolved status is not treated as live", () => {
    expect(hasUnfinishedRun(itemWith([null]))).toBe(false);
  });

  test("one open run among finished ones still warns", () => {
    expect(hasUnfinishedRun(itemWith(["completed", "in_progress"]))).toBe(true);
  });

  test("a task with no runs yet needs no warning", () => {
    expect(hasUnfinishedRun(itemWith([]))).toBe(false);
  });
});
