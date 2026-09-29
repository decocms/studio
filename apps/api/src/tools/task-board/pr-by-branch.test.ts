import { describe, expect, test } from "bun:test";
import { candidateHeadRefs } from "./pr-by-branch";

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

  test("derives the flat ref when the repository needs it", () => {
    expect(
      candidateHeadRefs("thread:abc/conn", "fix/real", { flat: true }),
    ).toEqual(["fix/real", "sandbox-thread-abc-conn"]);
  });

  test("keeps a real git ref as-is in the flat form too", () => {
    expect(candidateHeadRefs("fix/foo", null, { flat: true })).toEqual([
      "fix/foo",
    ]);
  });
});
