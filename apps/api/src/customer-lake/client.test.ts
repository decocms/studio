import { describe, expect, mock, test } from "bun:test";

mock.module("../settings", () => ({
  getSettings: () => ({
    customerLakeUrl: "https://lake.example",
    customerLakeAdminUsername: "admin",
    customerLakeAdminPassword: "admin-pw",
    customerLakeTenantSecret: "secret",
  }),
}));

let adminConnects = 0;
mock.module("@clickhouse/client", () => ({
  createClient: (opts: { username: string }) => {
    if (opts.username === "admin") adminConnects++;
    return {
      command: async () => {},
      query: async () => ({ json: async () => [] }),
      close: async () => {},
    };
  },
}));

const { normalizeQuery, tenantCredentials, queryCustomerLake } = await import(
  "./client"
);

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

describe("ensureTenantUser", () => {
  test("concurrent queries for a cold org share one admin connection", async () => {
    adminConnects = 0;
    await Promise.all([
      queryCustomerLake("orgConcurrentA", "SELECT 1"),
      queryCustomerLake("orgConcurrentA", "SELECT 1"),
      queryCustomerLake("orgConcurrentA", "SELECT 1"),
    ]);
    expect(adminConnects).toBe(1);
  });
});
