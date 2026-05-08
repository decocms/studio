import { describe, expect, test } from "bun:test";

import { generateBranchName } from "./branch-name";

describe("generateBranchName", () => {
  test("returns a string with the deco/ prefix", () => {
    const name = generateBranchName();
    expect(name.startsWith("deco/")).toBe(true);
  });

  test("returns a hyphenated two-word body after the prefix", () => {
    const name = generateBranchName();
    const body = name.slice("deco/".length);
    const parts = body.split("-");
    expect(parts.length).toBe(2);
    expect(parts[0]!.length).toBeGreaterThan(0);
    expect(parts[1]!.length).toBeGreaterThan(0);
  });

  test("is valid for git ref syntax", () => {
    const pattern = /^[A-Za-z0-9._/-]+$/;
    for (let i = 0; i < 10; i++) {
      const name = generateBranchName();
      expect(pattern.test(name)).toBe(true);
      expect(name.startsWith("-")).toBe(false);
    }
  });
});
