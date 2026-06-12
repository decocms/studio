import { describe, expect, it } from "bun:test";
import { canonicalizePhone, displayPhone, maskPhone } from "./phone";

describe("canonicalizePhone", () => {
  it("strips '+', spaces and punctuation to bare digits", () => {
    expect(canonicalizePhone("+55 (11) 99888-7777")).toBe("5511998887777");
    expect(canonicalizePhone("5511998887777")).toBe("5511998887777");
    expect(canonicalizePhone(null)).toBe("");
    expect(canonicalizePhone(undefined)).toBe("");
  });
});

describe("displayPhone / maskPhone", () => {
  it("adds a leading '+' for display", () => {
    expect(displayPhone("5511998887777")).toBe("+5511998887777");
    expect(displayPhone("")).toBe("");
  });
  it("masks all but the last 4 digits", () => {
    expect(maskPhone("5511998887777")).toMatch(/7777$/);
    expect(maskPhone("5511998887777")).not.toContain("5511");
    expect(maskPhone("")).toBe("");
  });
});
