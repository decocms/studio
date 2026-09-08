import { describe, expect, test } from "bun:test";
import { candidateHeadRefs, firstPrFromListResult } from "./pr-by-branch";

describe("candidateHeadRefs", () => {
  test("derives the sandbox ref from a synthetic branch", () => {
    expect(candidateHeadRefs("thread:abc", null)).toEqual([
      "sandbox/thread-abc",
    ]);
  });

  test("keeps a real git ref as-is", () => {
    expect(candidateHeadRefs("fix/foo", null)).toEqual(["fix/foo"]);
  });

  test("prefers the daemon's recorded ref, keeping the derived one as fallback", () => {
    expect(candidateHeadRefs("thread:abc/conn", "fix/real")).toEqual([
      "fix/real",
      "sandbox/thread-abc-conn",
    ]);
  });

  test("dedupes when the recorded ref is the derived one", () => {
    expect(candidateHeadRefs("thread:abc", "sandbox/thread-abc")).toEqual([
      "sandbox/thread-abc",
    ]);
  });
});

describe("firstPrFromListResult", () => {
  test("reads a bare array of REST pull requests", () => {
    expect(
      firstPrFromListResult([
        { html_url: "https://github.com/o/r/pull/7", number: 7 },
      ]),
    ).toMatchObject({ owner: "o", repo: "r", number: 7 });
  });

  test("reads the wrapped shapes", () => {
    for (const key of ["pull_requests", "items", "data"]) {
      expect(
        firstPrFromListResult({
          [key]: [{ url: "https://github.com/o/r/pull/9" }],
        }),
      ).toMatchObject({ number: 9 });
    }
  });

  test("skips rows whose url is not a pull request", () => {
    expect(
      firstPrFromListResult([
        { url: "https://api.github.com/repos/o/r/issues/1" },
        { html_url: "https://github.com/o/r/pull/12" },
      ]),
    ).toMatchObject({ number: 12 });
  });

  test("null on an empty or unrecognized result", () => {
    expect(firstPrFromListResult([])).toBeNull();
    expect(firstPrFromListResult({ nope: 1 })).toBeNull();
    expect(firstPrFromListResult(null)).toBeNull();
  });
});
