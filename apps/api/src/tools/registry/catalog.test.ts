import { describe, expect, test } from "bun:test";
import {
  catalogFilters,
  findCatalogItem,
  listCatalog,
  parseCatalog,
} from "./catalog";

const items = parseCatalog([
  {
    id: "deco/zeta",
    title: "Zeta",
    server: {
      name: "zeta",
      remotes: [
        {
          type: "HTTP",
          url: "https://example.com/mcp",
          headers: [{ name: "X-API-Key", isSecret: true }],
        },
      ],
    },
    _meta: { "mcp.mesh": { tags: ["data"], categories: ["Analytics"] } },
  },
  {
    id: "deco/alpha",
    title: "Alpha",
    description: "Search projects",
    server: { name: "alpha" },
    _meta: {
      "mcp.studio": { tags: ["search", "data"], categories: ["Search"] },
    },
  },
]);

describe("Deco JSON catalog", () => {
  test("accepts the repository shape without database audit fields and preserves install parameters", () => {
    expect(items[0]?.name).toBe("zeta");
    expect(items[0]?.server.remotes?.[0]?.headers).toEqual([
      { name: "X-API-Key", isSecret: true },
    ]);
    expect(items[0]?.created_at).toBeUndefined();
  });

  test("rejects malformed catalogs and duplicate ids", () => {
    expect(() => parseCatalog({ items })).toThrow();
    expect(() =>
      parseCatalog([{ id: "missing-server", title: "Invalid" }]),
    ).toThrow();
    expect(() => parseCatalog([items[0], items[0]])).toThrow(
      "Duplicate registry id",
    );
    expect(parseCatalog([])).toEqual([]);
  });

  test("paginates in a stable order without changing the cached array", () => {
    const page = listCatalog(items, { limit: 1 });
    expect(page.items.map((item) => item.id)).toEqual(["deco/alpha"]);
    expect(page.totalCount).toBe(2);
    expect(page.nextCursor).toBe("1");
    const next = listCatalog(items, { limit: 1, cursor: page.nextCursor });
    expect(next.items.map((item) => item.id)).toEqual(["deco/zeta"]);
    expect(next.hasMore).toBe(false);
    expect(next.nextCursor).toBeUndefined();
    expect(items[0]?.id).toBe("deco/zeta");
    expect(listCatalog(items, { cursor: "100" }).items).toEqual([]);
    for (const cursor of [
      "-1",
      "NaN",
      "1.5",
      "",
      "Infinity",
      "9007199254740992",
    ]) {
      expect(() => listCatalog(items, { cursor })).toThrow(
        "Invalid registry cursor",
      );
    }
  });

  test("filters names, case-insensitive search and metadata before pagination", () => {
    expect(
      listCatalog(items, {
        where: { field: ["name"], operator: "in", value: ["alpha"] },
      }).items.map((item) => item.id),
    ).toEqual(["deco/alpha"]);
    expect(
      listCatalog(items, {
        where: {
          operator: "or",
          conditions: [
            { field: ["description"], operator: "contains", value: "SEARCH" },
            { field: ["server", "name"], operator: "eq", value: "zeta" },
          ],
        },
      }).totalCount,
    ).toBe(2);
    expect(
      listCatalog(items, {
        tags: ["search", "data"],
        categories: ["Search"],
        limit: 1,
      }).totalCount,
    ).toBe(1);
    expect(listCatalog(items, { tags: ["missing"] }).items).toEqual([]);
  });

  test("supports nested filters and requested ordering", () => {
    expect(
      listCatalog(items, {
        where: {
          operator: "and",
          conditions: [
            { field: ["title"], operator: "like", value: "%a" },
            {
              operator: "not",
              conditions: [
                { field: ["id"], operator: "eq", value: "deco/alpha" },
              ],
            },
          ],
        },
      }).items.map((item) => item.id),
    ).toEqual(["deco/zeta"]);
    expect(
      listCatalog(items, {
        orderBy: [{ field: ["title"], direction: "desc" }],
      }).items.map((item) => item.title),
    ).toEqual(["Zeta", "Alpha"]);
  });

  test("resolves exact ids before names and returns null for unknown items", () => {
    expect(findCatalogItem(items, "deco/alpha")?.title).toBe("Alpha");
    expect(findCatalogItem(items, "zeta")?.id).toBe("deco/zeta");
    expect(findCatalogItem(items, "unknown")).toBeNull();
  });

  test("builds facets from both supported metadata namespaces", () => {
    expect(catalogFilters(items)).toEqual({
      tags: [
        { value: "data", count: 2 },
        { value: "search", count: 1 },
      ],
      categories: [
        { value: "Analytics", count: 1 },
        { value: "Search", count: 1 },
      ],
    });
  });
});
