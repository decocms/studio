import { describe, expect, it } from "bun:test";
import {
  getProjectScope,
  isProjectAllowed,
  PROJECT_SCOPE_KEY,
} from "./project-scope";

describe("getProjectScope", () => {
  it("returns null when permission is missing", () => {
    expect(getProjectScope(undefined)).toBeNull();
    expect(getProjectScope(null)).toBeNull();
  });

  it("returns null when the projects key is absent (backward compatible)", () => {
    expect(getProjectScope({ self: ["*"] })).toBeNull();
    expect(getProjectScope({ conn_abc: ["SEND_MESSAGE"] })).toBeNull();
  });

  it("returns null when the projects key is not an array", () => {
    // Defensive: stored JSON could be malformed.
    expect(
      getProjectScope({ [PROJECT_SCOPE_KEY]: "conn_a" as unknown as string[] }),
    ).toBeNull();
  });

  it("returns the allowlist when present", () => {
    expect(
      getProjectScope({ [PROJECT_SCOPE_KEY]: ["conn_a", "conn_b"] }),
    ).toEqual(["conn_a", "conn_b"]);
  });

  it("distinguishes an empty allowlist from unrestricted", () => {
    expect(getProjectScope({ [PROJECT_SCOPE_KEY]: [] })).toEqual([]);
  });
});

describe("isProjectAllowed", () => {
  it("allows anything when unrestricted (null scope)", () => {
    expect(isProjectAllowed(null, "conn_a")).toBe(true);
  });

  it("allows only listed ids", () => {
    expect(isProjectAllowed(["conn_a", "conn_b"], "conn_a")).toBe(true);
    expect(isProjectAllowed(["conn_a", "conn_b"], "conn_c")).toBe(false);
  });

  it("denies everything for an empty allowlist", () => {
    expect(isProjectAllowed([], "conn_a")).toBe(false);
  });

  it("allows any id when the wildcard is present", () => {
    expect(isProjectAllowed(["*"], "conn_anything")).toBe(true);
  });
});
