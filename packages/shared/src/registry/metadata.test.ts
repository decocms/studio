import { describe, expect, test } from "bun:test";
import {
  getStudioMcpMetadata,
  LEGACY_MESH_MCP_META_KEY,
  STUDIO_MCP_META_KEY,
  withStudioMcpMetadata,
} from "./metadata";

describe("Studio MCP metadata compatibility", () => {
  test("prefers canonical metadata over its legacy alias", () => {
    expect(
      getStudioMcpMetadata({
        [STUDIO_MCP_META_KEY]: { friendly_name: "Studio" },
        [LEGACY_MESH_MCP_META_KEY]: { friendly_name: "Legacy" },
      }),
    ).toEqual({ friendly_name: "Studio" });
  });

  test("reads metadata stored under the legacy alias", () => {
    expect(
      getStudioMcpMetadata({
        [LEGACY_MESH_MCP_META_KEY]: { verified: true },
      }),
    ).toEqual({ verified: true });
  });

  test("dual-writes metadata while preserving unrelated keys", () => {
    const studioMetadata = { tags: ["payments"] };
    const metadata = withStudioMcpMetadata(
      { "third.party": { enabled: true } },
      studioMetadata,
    );

    expect(metadata[STUDIO_MCP_META_KEY]).toEqual(studioMetadata);
    expect(metadata[LEGACY_MESH_MCP_META_KEY]).toEqual(studioMetadata);
    expect(metadata["third.party"]).toEqual({ enabled: true });
  });
});
