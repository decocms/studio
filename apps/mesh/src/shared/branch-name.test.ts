import { describe, expect, test } from "bun:test";

import { generateBranchName } from "./branch-name";

describe("generateBranchName", () => {
  test("returns <user-slug>-<base36-timestamp>", () => {
    const name = generateBranchName("Tavano");
    expect(name).toMatch(/^tavano-[0-9a-z]+$/);
  });

  test("slugifies the label: lowercases, strips accents, collapses separators", () => {
    const name = generateBranchName("João Silva");
    expect(name).toMatch(/^joao-silva-[0-9a-z]+$/);
  });

  test("falls back to 'user' when the label has no usable characters", () => {
    expect(generateBranchName("")).toMatch(/^user-[0-9a-z]+$/);
    expect(generateBranchName(null)).toMatch(/^user-[0-9a-z]+$/);
    expect(generateBranchName("!!!")).toMatch(/^user-[0-9a-z]+$/);
  });

  test("does not include a namespace prefix", () => {
    expect(generateBranchName("Tavano").includes("/")).toBe(false);
  });

  test("is valid git ref syntax and never starts with a hyphen", () => {
    const pattern = /^[A-Za-z0-9._/-]+$/;
    for (const label of ["Tavano", "José", "a.b_c", "  spaced  "]) {
      const name = generateBranchName(label);
      expect(pattern.test(name)).toBe(true);
      expect(name.startsWith("-")).toBe(false);
    }
  });
});
