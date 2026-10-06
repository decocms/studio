import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { createClientPool } from "./client-pool";
import { createOutboundClient } from "./index";

describe("createOutboundClient SSRF guard", () => {
  test("rejects an HTTP connection targeting a private/metadata address before building headers or connecting", async () => {
    const connection = {
      id: "conn_1",
      connection_type: "HTTP",
      connection_url: "http://169.254.169.254/latest/meta-data",
      connection_headers: null,
    } as unknown as ConnectionEntity;

    const ctx = {
      connectionId: undefined,
      getOrCreateClient: createClientPool(),
    } as unknown as StudioContext;

    await expect(createOutboundClient(connection, ctx)).rejects.toThrow(
      /private networks/i,
    );
  });
});
