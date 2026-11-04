import { describe, expect, it } from "bun:test";
import {
  connectionGrantsFor,
  narrowConnectionGrants,
  selfToolGrantsFor,
} from "./org-mcp-grants";

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

describe("connectionGrantsFor with scopes and denials", () => {
  const ids = ["conn_a", "conn_b"];

  it("gives every connection the connections scope covers, less its denials", () => {
    expect(
      connectionGrantsFor({
        role: "team",
        roleStatements: [
          { connections: ["*", "!conn_b"], conn_a: ["!DELETE"] },
        ],
        connectionIds: ids,
      }),
    ).toEqual({ conn_a: ["*", "!DELETE"] });
  });

  it("carries a per-tool denial into the key", () => {
    expect(
      connectionGrantsFor({
        role: "team",
        roleStatements: [{ conn_a: ["*", "!DELETE"] }],
        connectionIds: ids,
      }),
    ).toEqual({ conn_a: ["*", "!DELETE"] });
  });

  it("lets another role grant what one role denies", () => {
    expect(
      connectionGrantsFor({
        role: "team,ops",
        roleStatements: [
          { connections: ["*", "!conn_b"] },
          { conn_b: ["READ"] },
        ],
        connectionIds: ids,
      }),
    ).toEqual({ conn_a: ["*"], conn_b: ["READ"] });
  });
});

describe("selfToolGrantsFor", () => {
  const toolNames = [
    "TASK_ADD_REPO",
    "generate_image",
    "COLLECTION_VIRTUAL_MCP_LIST",
    "COLLECTION_VIRTUAL_MCP_DELETE",
  ];
  const runScoped = new Set(["TASK_ADD_REPO"]);

  it("gives an admin everything the run serves", () => {
    expect(
      selfToolGrantsFor({
        role: "admin",
        roleStatements: [],
        toolNames,
        runScoped,
      }),
    ).toEqual(toolNames);
  });

  // Without the cut a chat's key would let a read-only member delete agents.
  it("cuts a custom role down to basic usage plus its own grants", () => {
    expect(
      selfToolGrantsFor({
        role: "viewer",
        roleStatements: [{ self: ["MONITORING_STATS"] }],
        toolNames,
        runScoped,
      }),
    ).toEqual([
      "TASK_ADD_REPO",
      "generate_image",
      "COLLECTION_VIRTUAL_MCP_LIST",
    ]);
  });

  it("honors what the custom role grants under self", () => {
    expect(
      selfToolGrantsFor({
        role: "agent-admin",
        roleStatements: [{ self: ["COLLECTION_VIRTUAL_MCP_DELETE"] }],
        toolNames,
        runScoped,
      }),
    ).toContain("COLLECTION_VIRTUAL_MCP_DELETE");
    expect(
      selfToolGrantsFor({
        role: "everything",
        roleStatements: [{ self: ["*"] }],
        toolNames,
        runScoped,
      }),
    ).toEqual(toolNames);
  });

  it("gives the built-in user role its extra grants (agents:manage)", () => {
    expect(
      selfToolGrantsFor({
        role: "user",
        roleStatements: [],
        toolNames,
        runScoped,
      }),
    ).toEqual(toolNames);
  });

  it("keeps run-scoped tools whatever the role", () => {
    expect(
      selfToolGrantsFor({
        role: undefined,
        roleStatements: [],
        toolNames: ["TASK_ADD_REPO", "COLLECTION_VIRTUAL_MCP_DELETE"],
        runScoped,
      }),
    ).toEqual(["TASK_ADD_REPO"]);
  });
});

describe("narrowConnectionGrants", () => {
  it("cuts a whole grant down to the listed tools", () => {
    expect(
      narrowConnectionGrants(
        { conn_vtex: ["*"], conn_ga4: ["*"] },
        { conn_vtex: ["VTEX_LIST_CATEGORIES", "VTEX_GET_PRODUCT"] },
      ),
    ).toEqual({
      conn_vtex: ["VTEX_LIST_CATEGORIES", "VTEX_GET_PRODUCT"],
      conn_ga4: ["*"],
    });
  });

  it("never widens: a tool the grant does not allow stays out", () => {
    expect(
      narrowConnectionGrants(
        { conn_vtex: ["*", "!VTEX_GET_PRODUCT"] },
        { conn_vtex: ["VTEX_LIST_CATEGORIES", "VTEX_GET_PRODUCT"] },
      ),
    ).toEqual({ conn_vtex: ["VTEX_LIST_CATEGORIES"] });
    expect(
      narrowConnectionGrants(
        { conn_vtex: ["VTEX_UPDATE_PRICE"] },
        { conn_vtex: ["VTEX_LIST_CATEGORIES"] },
      ),
    ).toEqual({});
  });

  it("leaves alone a connection the grants do not have", () => {
    expect(
      narrowConnectionGrants({}, { conn_vtex: ["VTEX_LIST_CATEGORIES"] }),
    ).toEqual({});
  });
});
