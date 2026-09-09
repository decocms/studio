/**
 * The panel's four-value mergeability, from the three neutral facts a
 * provider reports. Pure — the read itself is e2e.
 */
import { describe, expect, it } from "bun:test";
import { toMergeableState } from "./use-pr-reviews.ts";

const cr = (over: Partial<Parameters<typeof toMergeableState>[0]> = {}) => ({
  conflicting: false,
  reviewBlocked: false,
  unresolvedConversations: 0,
  ...over,
});

describe("toMergeableState", () => {
  it("is clean when nothing is outstanding", () => {
    expect(toMergeableState(cr())).toBe("clean");
  });

  /** A conflict is about the branch, and it outranks anything a person owes. */
  it("is dirty for a conflict, whatever else is outstanding", () => {
    expect(toMergeableState(cr({ conflicting: true }))).toBe("dirty");
    expect(
      toMergeableState(cr({ conflicting: true, reviewBlocked: true })),
    ).toBe("dirty");
  });

  /**
   * Unknown must not read as clean: both providers compute mergeability
   * asynchronously, so "not worked out yet" is routine and the panel has to
   * say so rather than promise a merge.
   */
  it("is unknown while the provider has not worked mergeability out", () => {
    expect(toMergeableState(cr({ conflicting: null }))).toBe("unknown");
    expect(
      toMergeableState(cr({ conflicting: null, reviewBlocked: true })),
    ).toBe("unknown");
  });

  it("is blocked when a person still owes something", () => {
    expect(toMergeableState(cr({ reviewBlocked: true }))).toBe("blocked");
    expect(toMergeableState(cr({ unresolvedConversations: 2 }))).toBe(
      "blocked",
    );
  });
});
