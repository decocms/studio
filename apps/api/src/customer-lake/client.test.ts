import { describe, expect, test } from "bun:test";
import { normalizeQuery, tenantCredentials } from "./client";

describe("tenantCredentials", () => {
  test("is stable per org and differs across orgs and secrets", () => {
    const a = tenantCredentials("elHj2q84gMLAdpVm", "s1");
    expect(a.username).toBe("org_elHj2q84gMLAdpVm");
    expect(tenantCredentials("elHj2q84gMLAdpVm", "s1")).toEqual(a);
    expect(tenantCredentials("other", "s1").password).not.toBe(a.password);
    expect(tenantCredentials("elHj2q84gMLAdpVm", "s2").password).not.toBe(
      a.password,
    );
  });

  test("rejects ids that could break out of the DDL", () => {
    for (const id of [
      "",
      "a`b",
      "a'b",
      "a b",
      "a;DROP USER x",
      "x".repeat(65),
    ]) {
      expect(() => tenantCredentials(id, "s1")).toThrow();
    }
  });
});

test("normalizeQuery drops trailing semicolons only", () => {
  expect(normalizeQuery("  SELECT 1;; \n")).toBe("SELECT 1");
  expect(normalizeQuery("SELECT ';'")).toBe("SELECT ';'");
});
