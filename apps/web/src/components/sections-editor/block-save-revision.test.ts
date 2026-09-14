import { describe, expect, test } from "bun:test";
import { BlockSaveRevisionTracker } from "./block-save-revision";

describe("BlockSaveRevisionTracker", () => {
  test("only lets the newest successful revision finalize the cache", () => {
    const tracker = new BlockSaveRevisionTracker();
    const first = tracker.begin("scope/page", {
      exists: true,
      value: { title: "before" },
    });
    const second = tracker.begin("scope/page", {
      exists: true,
      value: { title: "first optimistic" },
    });

    expect(tracker.isLatest(first)).toBe(false);
    expect(tracker.isLatest(second)).toBe(true);
    expect(
      tracker.recordSuccess(first, {
        exists: true,
        value: { title: "first" },
      }),
    ).toBe(false);
    expect(
      tracker.recordSuccess(second, {
        exists: true,
        value: { title: "second" },
      }),
    ).toBe(true);

    tracker.settle(first);
    tracker.settle(second);
  });

  test("rolls the newest failure back to the latest successful write", () => {
    const tracker = new BlockSaveRevisionTracker();
    const first = tracker.begin("scope/page", {
      exists: true,
      value: { title: "before" },
    });
    const second = tracker.begin("scope/page", {
      exists: true,
      value: { title: "first optimistic" },
    });

    expect(
      tracker.recordSuccess(first, {
        exists: true,
        value: { title: "first" },
      }),
    ).toBe(false);
    expect(tracker.rollbackFor(second)).toEqual({
      exists: true,
      value: { title: "first" },
    });

    tracker.settle(first);
    tracker.settle(second);
  });

  test("rolls an all-failed chain back to its original absence", () => {
    const tracker = new BlockSaveRevisionTracker();
    const first = tracker.begin("scope/page", {
      exists: false,
      value: undefined,
    });
    const second = tracker.begin("scope/page", {
      exists: true,
      value: { title: "first optimistic" },
    });

    expect(tracker.rollbackFor(first)).toBeNull();
    expect(tracker.rollbackFor(second)).toEqual({
      exists: false,
      value: undefined,
    });

    tracker.settle(first);
    tracker.settle(second);
  });

  test("keeps rollback history isolated across interleaved blocks", () => {
    const tracker = new BlockSaveRevisionTracker();
    const firstPageSave = tracker.begin("scope/page", {
      exists: true,
      value: { title: "before page" },
    });
    const otherBlockSave = tracker.begin("scope/other", {
      exists: true,
      value: { title: "before other" },
    });
    const latestPageSave = tracker.begin("scope/page", {
      exists: true,
      value: { title: "first page optimistic" },
    });

    tracker.recordSuccess(firstPageSave, {
      exists: true,
      value: { title: "first page committed" },
    });
    expect(
      tracker.recordSuccess(otherBlockSave, {
        exists: true,
        value: { title: "other committed" },
      }),
    ).toBe(true);
    expect(tracker.rollbackFor(latestPageSave)).toEqual({
      exists: true,
      value: { title: "first page committed" },
    });

    tracker.settle(firstPageSave);
    tracker.settle(otherBlockSave);
    tracker.settle(latestPageSave);
  });
});
