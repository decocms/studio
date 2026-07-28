import { describe, expect, it } from "bun:test";
import { pickGitBranch, pickRecordableHeadRef } from "./head-ref";

const DERIVED = "sandbox/thread-thrd_abc-conn_1";
const SYNTHETIC = "thread:thrd_abc/conn_1";

describe("pickRecordableHeadRef", () => {
  it("records a branch that differs from the requested ref", () => {
    expect(
      pickRecordableHeadRef({
        status: { current: "restore-visible-search", detached: false },
        requestedRef: DERIVED,
      }),
    ).toBe("restore-visible-search");
  });

  it("skips the requested ref itself — that memory must survive a failed restore", () => {
    // A boot that couldn't restore leaves HEAD on the derived ref. Recording it
    // would erase the PR branch and re-break the next boot.
    expect(
      pickRecordableHeadRef({
        status: { current: DERIVED, detached: false },
        requestedRef: DERIVED,
      }),
    ).toBeNull();
  });

  it("skips detached HEAD, missing, empty and absent status", () => {
    expect(
      pickRecordableHeadRef({
        status: { current: "abc1234", detached: true },
        requestedRef: DERIVED,
      }),
    ).toBeNull();
    expect(
      pickRecordableHeadRef({
        status: { current: null },
        requestedRef: DERIVED,
      }),
    ).toBeNull();
    expect(
      pickRecordableHeadRef({ status: { current: "" }, requestedRef: DERIVED }),
    ).toBeNull();
    expect(
      pickRecordableHeadRef({ status: {}, requestedRef: DERIVED }),
    ).toBeNull();
    expect(
      pickRecordableHeadRef({ status: null, requestedRef: DERIVED }),
    ).toBeNull();
  });

  it("refuses the repo default — a recorded ref is also the shutdown push target", () => {
    // Someone runs `git checkout main` in the sandbox. Remembering that would
    // check main out on the next boot AND aim the daemon's shutdown sync at it.
    expect(
      pickRecordableHeadRef({
        status: { current: "main", detached: false, base: "main" },
        requestedRef: DERIVED,
      }),
    ).toBeNull();
    // Also refused by name when `base` is missing from the payload.
    for (const current of ["main", "master", "trunk", "develop", "HEAD"]) {
      expect(
        pickRecordableHeadRef({ status: { current }, requestedRef: DERIVED }),
      ).toBeNull();
    }
    // A non-conventional default is caught via `base`.
    expect(
      pickRecordableHeadRef({
        status: { current: "production", base: "production" },
        requestedRef: DERIVED,
      }),
    ).toBeNull();
    // …and that same name IS recordable when it isn't the default.
    expect(
      pickRecordableHeadRef({
        status: { current: "production", base: "main" },
        requestedRef: DERIVED,
      }),
    ).not.toBeNull();
  });

  it("records even when nothing was requested (no ref to match)", () => {
    expect(
      pickRecordableHeadRef({
        status: { current: "restore-visible-search" },
        requestedRef: null,
      }),
    ).not.toBeNull();
  });
});

describe("pickGitBranch", () => {
  it("prefers the recorded head ref for a synthetic key when sticky", () => {
    expect(
      pickGitBranch({
        branch: SYNTHETIC,
        derivedRef: DERIVED,
        recordedHeadRef: "restore-visible-search",
        sticky: true,
      }),
    ).toBe("restore-visible-search");
  });

  it("falls back to the derived ref with the flag off — today's behavior", () => {
    expect(
      pickGitBranch({
        branch: SYNTHETIC,
        derivedRef: DERIVED,
        recordedHeadRef: "restore-visible-search",
        sticky: false,
      }),
    ).toBe(DERIVED);
  });

  it("falls back to the derived ref when nothing was recorded", () => {
    for (const recordedHeadRef of [null, undefined, ""]) {
      expect(
        pickGitBranch({
          branch: SYNTHETIC,
          derivedRef: DERIVED,
          recordedHeadRef,
          sticky: true,
        }),
      ).toBe(DERIVED);
    }
  });

  it("never rewrites a real (non-synthetic) branch", () => {
    expect(
      pickGitBranch({
        branch: "feat/thing",
        derivedRef: DERIVED,
        recordedHeadRef: "restore-visible-search",
        sticky: true,
      }),
    ).toBe("feat/thing");
  });
});
