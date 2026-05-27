import { describe, expect, it } from "bun:test";
import {
  isValidPagePath,
  normalizePagePath,
  validatePagePath,
} from "./page-path-utils";

describe("page-path-utils", () => {
  it("normalizePagePath collapses trailing slashes", () => {
    expect(normalizePagePath("/about/")).toBe("/about");
    expect(normalizePagePath("/")).toBe("/");
  });

  it("isValidPagePath rejects unsafe paths", () => {
    expect(isValidPagePath("/about")).toBe(true);
    expect(isValidPagePath("//evil.com")).toBe(false);
    expect(isValidPagePath("/../secret")).toBe(false);
    expect(isValidPagePath("about")).toBe(false);
  });

  it("validatePagePath returns error messages", () => {
    expect(validatePagePath("/about")).toBeNull();
    expect(validatePagePath("//evil.com")).toMatch(/must start with/);
  });
});
