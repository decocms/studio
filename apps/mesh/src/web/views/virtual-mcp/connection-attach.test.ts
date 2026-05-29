import { describe, expect, it } from "bun:test";
import { connectionAttachTarget } from "./connection-attach";

describe("connectionAttachTarget", () => {
  it("attaches an org-scoped connection as a concrete child", () => {
    expect(
      connectionAttachTarget({ id: "conn_1", access: "org", app_id: "mcp-x" }),
    ).toEqual({ kind: "connection", connectionId: "conn_1" });
  });

  it("attaches a user-private connection as a typed slot keyed by app_id", () => {
    expect(
      connectionAttachTarget({
        id: "conn_2",
        access: "user",
        app_id: "mcp-github",
      }),
    ).toEqual({ kind: "slot", slotAppId: "mcp-github" });
  });

  it("skips a user-private connection that has no app_id", () => {
    expect(
      connectionAttachTarget({ id: "conn_3", access: "user", app_id: null }),
    ).toEqual({ kind: "skip-no-app-id" });
  });

  it("treats an undefined app_id on a user connection as unslottable", () => {
    expect(connectionAttachTarget({ id: "conn_4", access: "user" })).toEqual({
      kind: "skip-no-app-id",
    });
  });

  it("attaches an org connection without an app_id as a concrete child", () => {
    expect(
      connectionAttachTarget({ id: "conn_5", access: "org", app_id: null }),
    ).toEqual({ kind: "connection", connectionId: "conn_5" });
  });
});
