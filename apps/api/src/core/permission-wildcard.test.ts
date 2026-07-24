import { describe, expect, it } from "bun:test";
import { createAccessControl } from "@decocms/better-auth/plugins/access";
import { buildWildcardPermission } from "./permission-wildcard";

// Pure-logic unit test (TESTING.md unit tier). No mocks: `createAccessControl`
// is the REAL Better Auth access-control matcher (a third-party dependency,
// exercised in-process), so these assertions verify the helper against the
// actual `authorize()` semantics the production `hasPermission` call relies on
// — not a fiction we typed. There is no HTTP/DB/auth-session here; the endpoint
// wrapper around `authorize` is what e2e covers.

describe("buildWildcardPermission", () => {
  it("maps every resource to the literal `*` action", () => {
    expect(buildWildcardPermission({ self: ["TOOL_A"] })).toEqual({
      self: ["*"],
    });
    expect(
      buildWildcardPermission({ conn_abc: ["SEND_MESSAGE"], self: ["X"] }),
    ).toEqual({ conn_abc: ["*"], self: ["*"] });
  });

  it("preserves resource keys and ignores the requested actions", () => {
    expect(buildWildcardPermission({ conn_abc: ["A", "B", "C"] })).toEqual({
      conn_abc: ["*"],
    });
  });

  it("returns an empty map for an empty request", () => {
    expect(buildWildcardPermission({})).toEqual({});
  });
});

// These tests pin the EXACT Better Auth semantics that justify keeping the
// exact probe and the wildcard probe as two separate calls. They are the
// reason the double `hasPermission` call cannot be collapsed into one.
describe("Better Auth authorize() — wildcard is literal, not expanded", () => {
  const ac = createAccessControl({ self: [] as string[] });
  const wildcardRole = ac.newRole({ self: ["*"] });
  const exactRole = ac.newRole({ self: ["TOOL_A"] });

  it("a `*` role is NOT matched by an exact request (needs the wildcard probe)", () => {
    expect(wildcardRole.authorize({ self: ["TOOL_A"] }).success).toBe(false);
    expect(
      wildcardRole.authorize(buildWildcardPermission({ self: ["TOOL_A"] }))
        .success,
    ).toBe(true);
  });

  it("an exact role is NOT matched by the wildcard request (needs the exact probe)", () => {
    expect(exactRole.authorize({ self: ["TOOL_A"] }).success).toBe(true);
    expect(
      exactRole.authorize(buildWildcardPermission({ self: ["TOOL_A"] }))
        .success,
    ).toBe(false);
  });

  it("a merged single array is AND-matched and fails BOTH roles — proving the calls cannot be merged", () => {
    const merged = { self: ["TOOL_A", "*"] };
    expect(wildcardRole.authorize(merged).success).toBe(false);
    expect(exactRole.authorize(merged).success).toBe(false);
  });
});
