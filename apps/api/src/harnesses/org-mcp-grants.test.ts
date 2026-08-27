import { describe, expect, it } from "bun:test";
import { connectionGrantsFor, rolesOf } from "./org-mcp-grants";

describe("connectionGrantsFor", () => {
  const ids = ["conn_a", "conn_b"];

  it("gives an owner every candidate connection — they bypass the check anyway", () => {
    expect(
      connectionGrantsFor({
        role: "owner",
        roleStatements: [],
        connectionIds: ids,
      }),
    ).toEqual({ conn_a: ["*"], conn_b: ["*"] });
  });

  it("gives an admin the same, including through a comma-joined role", () => {
    expect(
      connectionGrantsFor({
        role: "billing-manager,admin",
        roleStatements: [],
        connectionIds: ids,
      }),
    ).toEqual({ conn_a: ["*"], conn_b: ["*"] });
  });

  it("gives a member nothing when no role grants a connection — as the proxy would", () => {
    expect(
      connectionGrantsFor({
        role: "user",
        roleStatements: [],
        connectionIds: ids,
      }),
    ).toEqual({});
  });

  it("keeps a partial grant partial", () => {
    expect(
      connectionGrantsFor({
        role: "support",
        roleStatements: [{ conn_a: ["VTEX_LIST_BRANDS", "VTEX_LIST_SKUS"] }],
        connectionIds: ids,
      }),
    ).toEqual({ conn_a: ["VTEX_LIST_BRANDS", "VTEX_LIST_SKUS"] });
  });

  it("unions across roles, and a wildcard subsumes named tools", () => {
    expect(
      connectionGrantsFor({
        role: "support,analyst",
        roleStatements: [{ conn_a: ["VTEX_LIST_BRANDS"] }, { conn_a: ["*"] }],
        connectionIds: ids,
      }),
    ).toEqual({ conn_a: ["*"] });
  });

  it("ignores grants for connections the run is not mounting", () => {
    expect(
      connectionGrantsFor({
        role: "support",
        roleStatements: [{ conn_elsewhere: ["*"], self: ["*"] }],
        connectionIds: ids,
      }),
    ).toEqual({});
  });
});

describe("rolesOf", () => {
  it("splits Better Auth's comma-joined multi-role value", () => {
    expect(rolesOf("admin, billing-manager")).toEqual([
      "admin",
      "billing-manager",
    ]);
  });

  it("is empty for a member with no role", () => {
    expect(rolesOf(undefined)).toEqual([]);
    expect(rolesOf("")).toEqual([]);
  });
});
