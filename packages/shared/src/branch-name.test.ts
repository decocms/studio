import { describe, expect, test } from "bun:test";

import { branchUserLabel, generateBranchName } from "./branch-name";

describe("branchUserLabel", () => {
  test("prefers the display name", () => {
    expect(branchUserLabel({ name: "Rafael", email: "valls@deco.cx" })).toBe(
      "Rafael",
    );
  });

  // The bug this helper exists for: Better Auth stores an unset display name as
  // "", which `??` treats as present. Every such user's branch slugged to the
  // literal "user" (171 prod threads) instead of their email local-part.
  test("an empty display name falls through to the email local-part", () => {
    expect(branchUserLabel({ name: "", email: "marco@wolycasa.com.br" })).toBe(
      "marco",
    );
  });

  test("null/absent name falls through to the email local-part", () => {
    expect(branchUserLabel({ name: null, email: "a@b.c" })).toBe("a");
    expect(branchUserLabel({ email: "a@b.c" })).toBe("a");
  });

  test("undefined when nothing is usable, so generateBranchName decides", () => {
    expect(branchUserLabel({ name: "", email: "" })).toBeUndefined();
    expect(branchUserLabel({})).toBeUndefined();
    expect(branchUserLabel(null)).toBeUndefined();
    expect(branchUserLabel(undefined)).toBeUndefined();
  });

  test("feeds generateBranchName a real slug for a name-less user", () => {
    expect(
      generateBranchName(
        branchUserLabel({ name: "", email: "marco@wolycasa.com.br" }),
      ),
    ).toMatch(/^marco-[0-9a-z]+$/);
  });
});

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
