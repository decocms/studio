import { describe, expect, it } from "bun:test";
import { fenceMatches } from "./run-fence";

describe("fenceMatches", () => {
  it("accepts when no fence is set (null current)", () => {
    expect(fenceMatches(null, "tok-1")).toBe(true);
    expect(fenceMatches(null, null)).toBe(true);
  });
  it("accepts an exact match", () => {
    expect(fenceMatches("tok-1", "tok-1")).toBe(true);
  });
  it("rejects a stale/absent presented token when a fence is set", () => {
    expect(fenceMatches("tok-2", "tok-1")).toBe(false);
    expect(fenceMatches("tok-2", null)).toBe(false);
  });
  it("treats an empty-string fence as set (not null)", () => {
    expect(fenceMatches("", "")).toBe(true);
    expect(fenceMatches("", null)).toBe(false);
  });
});
