import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "../connection/schema";
import { storeConnections } from "./plan-goal-connections";

const connection = (
  id: string,
  connection_type: ConnectionEntity["connection_type"] = "HTTP",
) => ({ id, connection_type }) as ConnectionEntity;

describe("storeConnections", () => {
  it("keeps the store's own connections", () => {
    const kept = storeConnections([
      connection("conn_vtex"),
      connection("conn_ga4", "SSE"),
    ]);
    expect(kept.map((c) => c.id)).toEqual(["conn_vtex", "conn_ga4"]);
  });

  it("drops virtual MCPs and Studio's own connections", () => {
    expect(
      storeConnections([
        connection("org_self"),
        connection("org_registry"),
        connection("org_community-registry"),
        connection("org_dev-assets"),
        connection("vir_agent", "VIRTUAL"),
      ]),
    ).toEqual([]);
  });
});
