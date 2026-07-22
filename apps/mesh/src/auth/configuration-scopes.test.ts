import { describe, expect, it } from "bun:test";
import {
  assertNoWildcardScopes,
  extractConnectionPermissions,
  getReferencedConnectionIds,
} from "./configuration-scopes";

// Pure-logic unit tests (TESTING.md unit tier). These guard the privilege-
// escalation fix: a connection's configuration scopes must never be able to
// mint an unconditional `{"*":["*"]}` grant. See WILDCARD_SCOPE for context.

describe("assertNoWildcardScopes", () => {
  it("throws when the wildcard '*' scope is present", () => {
    expect(() => assertNoWildcardScopes(["*"])).toThrow(/Wildcard/);
    expect(() =>
      assertNoWildcardScopes(["CONN::READ", "*", "CONN::WRITE"]),
    ).toThrow(/Wildcard/);
  });

  it("allows resource-scoped scopes and empty/absent inputs", () => {
    expect(() =>
      assertNoWildcardScopes(["CONN::READ", "SELF::WRITE"]),
    ).not.toThrow();
    expect(() => assertNoWildcardScopes([])).not.toThrow();
    expect(() => assertNoWildcardScopes(null)).not.toThrow();
    expect(() => assertNoWildcardScopes(undefined)).not.toThrow();
  });
});

describe("extractConnectionPermissions", () => {
  it("never expands '*' into a full wildcard grant (defense-in-depth)", () => {
    // Even if a legacy connection persisted "*" before write-time validation
    // existed, minting must not produce the escalation-enabling grant.
    expect(extractConnectionPermissions({ x: 1 }, ["*"])).toEqual({});
    expect(
      extractConnectionPermissions({ CONN: { value: "conn_abc" } }, [
        "*",
        "CONN::READ",
      ]),
    ).toEqual({ conn_abc: ["READ"] });
  });

  it("maps resource-scoped scopes to their referenced connection", () => {
    expect(
      extractConnectionPermissions({ CONN: { value: "conn_abc" } }, [
        "CONN::READ",
        "CONN::WRITE",
      ]),
    ).toEqual({ conn_abc: ["READ", "WRITE"] });
  });
});

describe("getReferencedConnectionIds", () => {
  it("excludes the wildcard sentinel", () => {
    expect(
      getReferencedConnectionIds({ CONN: { value: "conn_abc" } }, [
        "*",
        "CONN::READ",
      ]),
    ).toEqual(new Set(["conn_abc"]));
  });
});
