import { describe, expect, it } from "bun:test";
import { matchesAdminToken } from "./admin";

describe("matchesAdminToken", () => {
  it("accepts an exact match", () => {
    expect(matchesAdminToken("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(matchesAdminToken("nope", "s3cret")).toBe(false);
    expect(matchesAdminToken("s3cretx", "s3cret")).toBe(false);
  });

  it("stays closed when the secret is unset — an empty header must not open it", () => {
    expect(matchesAdminToken("", "")).toBe(false);
    expect(matchesAdminToken(undefined, undefined)).toBe(false);
    expect(matchesAdminToken("anything", undefined)).toBe(false);
    expect(matchesAdminToken(undefined, "s3cret")).toBe(false);
  });
});
