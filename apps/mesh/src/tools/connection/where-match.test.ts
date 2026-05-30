import { describe, expect, it } from "bun:test";
import type { ConnectionEntity } from "./schema";
import { connectionMatchesWhere } from "./where-match";

/**
 * Minimal stand-in for the synthetic "Local Files" (dev-assets) connection.
 * The matcher only reads entity fields, so a partial literal is sufficient.
 */
const devAssets = {
  id: "org_1_dev-assets",
  title: "Local Files",
  description:
    "Local file storage for development. Files are stored in /data/assets/.",
  app_name: "@deco/dev-assets-mcp",
  connection_type: "HTTP",
  connection_url: "http://localhost:3000/mcp/dev-assets",
  status: "active",
  bindings: ["OBJECT_STORAGE"],
} as unknown as ConnectionEntity;

describe("connectionMatchesWhere", () => {
  it("returns true when there is no where filter", () => {
    expect(connectionMatchesWhere(devAssets, undefined)).toBe(true);
  });

  it("excludes the dev-assets connection from an app_name filter for a different app (the instance-selector bug)", () => {
    // The agent instance selector queries with app_name = <the connection's app>.
    // Local Files must NOT leak into every app's instance dropdown.
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["app_name"],
        operator: "eq",
        value: "@deco/cms",
      }),
    ).toBe(false);
  });

  it("includes the dev-assets connection when the app_name filter targets its own app", () => {
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["app_name"],
        operator: "eq",
        value: "@deco/dev-assets-mcp",
      }),
    ).toBe(true);
  });

  it("matches a case-insensitive `contains` search against the title", () => {
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["title"],
        operator: "contains",
        value: "FILES",
      }),
    ).toBe(true);
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["title"],
        operator: "contains",
        value: "cms",
      }),
    ).toBe(false);
  });

  it("treats an unknown/absent field as a no-op (mirrors applyWhereToSql)", () => {
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["nonexistent_field"],
        operator: "eq",
        value: "whatever",
      }),
    ).toBe(true);
  });

  it("resolves the derived `slug` field via getConnectionSlug", () => {
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["slug"],
        operator: "eq",
        value: "@deco/dev-assets-mcp",
      }),
    ).toBe(true);
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["slug"],
        operator: "eq",
        value: "@deco/cms",
      }),
    ).toBe(false);
  });

  it("supports the `in` operator", () => {
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["connection_type"],
        operator: "in",
        value: ["HTTP", "SSE"],
      }),
    ).toBe(true);
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["connection_type"],
        operator: "in",
        value: ["STDIO"],
      }),
    ).toBe(false);
    // Non-array value mirrors SQL's `false`
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["connection_type"],
        operator: "in",
        value: "HTTP",
      }),
    ).toBe(false);
  });

  it("supports the `like` operator with SQL wildcards, case-insensitively", () => {
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["app_name"],
        operator: "like",
        value: "@deco/%",
      }),
    ).toBe(true);
    expect(
      connectionMatchesWhere(devAssets, {
        field: ["app_name"],
        operator: "like",
        value: "@other/%",
      }),
    ).toBe(false);
  });

  describe("logical operators", () => {
    it("`and` requires every condition to match", () => {
      expect(
        connectionMatchesWhere(devAssets, {
          operator: "and",
          conditions: [
            {
              field: ["app_name"],
              operator: "eq",
              value: "@deco/dev-assets-mcp",
            },
            { field: ["connection_type"], operator: "eq", value: "HTTP" },
          ],
        }),
      ).toBe(true);
      expect(
        connectionMatchesWhere(devAssets, {
          operator: "and",
          conditions: [
            {
              field: ["app_name"],
              operator: "eq",
              value: "@deco/dev-assets-mcp",
            },
            { field: ["connection_type"], operator: "eq", value: "STDIO" },
          ],
        }),
      ).toBe(false);
    });

    it("`or` requires at least one condition to match", () => {
      expect(
        connectionMatchesWhere(devAssets, {
          operator: "or",
          conditions: [
            { field: ["app_name"], operator: "eq", value: "@deco/cms" },
            { field: ["connection_type"], operator: "eq", value: "HTTP" },
          ],
        }),
      ).toBe(true);
    });

    it("`not` negates the conjunction of its conditions", () => {
      expect(
        connectionMatchesWhere(devAssets, {
          operator: "not",
          conditions: [
            { field: ["app_name"], operator: "eq", value: "@deco/cms" },
          ],
        }),
      ).toBe(true);
    });

    it("an empty condition list is a no-op (true)", () => {
      expect(
        connectionMatchesWhere(devAssets, { operator: "and", conditions: [] }),
      ).toBe(true);
    });
  });
});
