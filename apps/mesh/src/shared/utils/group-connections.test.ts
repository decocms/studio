import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "@decocms/mesh-sdk";
import { groupConnections } from "./group-connections";

/** Minimal stand-in — grouping only reads app_name/title/icon/connection_url. */
const conn = (fields: Partial<ConnectionEntity>) =>
  ({
    id: "id",
    title: "Connection",
    app_name: null,
    connection_url: null,
    icon: null,
    ...fields,
  }) as unknown as ConnectionEntity;

describe("groupConnections", () => {
  it("keeps a connection with a unique slug as a single item", () => {
    const a = conn({ id: "a", app_name: "vtex", title: "VTEX" });
    expect(groupConnections([a])).toEqual([{ type: "single", connection: a }]);
  });

  it("groups multiple connections sharing the same app_name", () => {
    const a = conn({ id: "a", app_name: "vtex", title: "VTEX (1)", icon: "i" });
    const b = conn({ id: "b", app_name: "vtex", title: "VTEX (2)" });
    const result = groupConnections([a, b]);
    expect(result).toEqual([
      {
        type: "group",
        key: "vtex",
        icon: "i",
        title: "VTEX",
        connections: [a, b],
      },
    ]);
  });

  it("does not strip a numeric suffix from the title when app_name is absent", () => {
    const a = conn({ id: "a", title: "Server (1)" });
    const b = conn({ id: "b", title: "Server (1)" });
    const result = groupConnections([a, b]);
    expect(result).toEqual([
      {
        type: "group",
        key: "server-1",
        icon: null,
        title: "Server (1)",
        connections: [a, b],
      },
    ]);
  });

  it("preserves first-seen order across singles and groups", () => {
    const a = conn({ id: "a", app_name: "vtex", title: "VTEX (1)" });
    const b = conn({ id: "b", app_name: "shopify", title: "Shopify" });
    const c = conn({ id: "c", app_name: "vtex", title: "VTEX (2)" });
    const result = groupConnections([a, b, c]);
    expect(
      result.map((item) =>
        item.type === "single" ? item.connection.id : item.key,
      ),
    ).toEqual(["vtex", "b"]);
  });
});
