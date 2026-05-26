import { describe, expect, test } from "bun:test";

import { isSyntheticBranch } from "./is-synthetic-branch";

describe("isSyntheticBranch", () => {
  test("returns true for the literal 'ephemeral' branch", () => {
    expect(isSyntheticBranch("ephemeral")).toBe(true);
  });

  test("returns true for any 'thread:...' prefixed branch", () => {
    expect(isSyntheticBranch("thread:abc-123")).toBe(true);
    expect(isSyntheticBranch("thread:")).toBe(true);
  });

  test("returns false for real branch names", () => {
    expect(isSyntheticBranch("main")).toBe(false);
    expect(isSyntheticBranch("deco/swift-glade")).toBe(false);
    expect(isSyntheticBranch("feature/x")).toBe(false);
  });

  test("does not match substrings or variants", () => {
    expect(isSyntheticBranch("ephemeral-foo")).toBe(false);
    expect(isSyntheticBranch("Ephemeral")).toBe(false);
    expect(isSyntheticBranch("my-thread:1")).toBe(false);
  });
});
