import { describe, expect, it } from "bun:test";
import {
  getProjectScope,
  isProjectAllowed,
  PROJECT_SCOPE_KEY,
  projectScopeFilter,
  unionProjectScopes,
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

  it("allows every project but the denied ones", () => {
    expect(isProjectAllowed(["*", "!conn_b"], "conn_a")).toBe(true);
    expect(isProjectAllowed(["*", "!conn_b"], "conn_b")).toBe(false);
  });
});

describe("projectScopeFilter", () => {
  it("does not filter an unrestricted caller", () => {
    expect(projectScopeFilter(null)).toEqual({ kind: "all" });
  });

  it("excludes denied projects from an all-projects scope", () => {
    expect(projectScopeFilter(["*", "!conn_b"])).toEqual({
      kind: "except",
      names: ["conn_b"],
    });
  });

  it("keeps an allowlist an allowlist", () => {
    expect(projectScopeFilter(["conn_a"])).toEqual({
      kind: "only",
      names: ["conn_a"],
    });
  });
});

describe("unionProjectScopes", () => {
  it("is unrestricted when any role is", () => {
    expect(unionProjectScopes([["p1"], null])).toBeNull();
  });

  it("admits the projects of every role", () => {
    const scope = unionProjectScopes([["p1"], ["p2"]]);
    expect(isProjectAllowed(scope, "p1")).toBe(true);
    expect(isProjectAllowed(scope, "p2")).toBe(true);
    expect(isProjectAllowed(scope, "p3")).toBe(false);
  });

  it("hides a project only when every role hides it", () => {
    const scope = unionProjectScopes([
      ["*", "!finance", "!hr"],
      ["*", "!finance"],
    ]);
    expect(isProjectAllowed(scope, "hr")).toBe(true);
    expect(isProjectAllowed(scope, "finance")).toBe(false);
  });

  it("lets an allowlist reopen a project another role hides", () => {
    const scope = unionProjectScopes([["*", "!finance"], ["finance"]]);
    expect(isProjectAllowed(scope, "finance")).toBe(true);
  });

  it("admits nothing for a role that admits nothing", () => {
    expect(unionProjectScopes([[]])).toEqual([]);
  });
});
