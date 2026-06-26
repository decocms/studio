import { describe, expect, it } from "bun:test";
import { createCatalog } from "./catalog";
import type { CatalogItem, CatalogSource } from "./types";

function item(name: string, id = name): CatalogItem {
  return {
    id,
    title: name,
    created_at: "",
    updated_at: "",
    server: { name },
  };
}

function source(id: string, items: CatalogItem[]): CatalogSource {
  return { id, load: async () => items };
}

function failingSource(id: string): CatalogSource {
  return {
    id,
    load: async () => {
      throw new Error(`${id} down`);
    },
  };
}

describe("createCatalog", () => {
  it("merges sources first-party-first and dedupes by server.name", async () => {
    const catalog = createCatalog([
      source("first-party", [item("airtable", "airtable@1"), item("github")]),
      source("community", [item("airtable", "airtable@2"), item("slack")]),
    ]);

    const { items, totalCount } = await catalog.listItems();
    expect(items.map((i) => i.id)).toEqual(["airtable@1", "github", "slack"]);
    expect(totalCount).toBe(3);
  });

  it("filters via the search query", async () => {
    const catalog = createCatalog([
      source("first-party", [item("airtable"), item("github"), item("gitlab")]),
    ]);
    const { items } = await catalog.listItems({ search: "git" });
    expect(items.map((i) => i.id)).toEqual(["github", "gitlab"]);
  });

  it("paginates with an opaque cursor", async () => {
    const all = ["a", "b", "c", "d", "e"].map((n) => item(n));
    const catalog = createCatalog([source("first-party", all)]);

    const page1 = await catalog.listItems({ limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual(["a", "b"]);
    expect(page1.totalCount).toBe(5);
    expect(page1.nextCursor).toBeDefined();

    const page2 = await catalog.listItems({
      limit: 2,
      cursor: page1.nextCursor,
    });
    expect(page2.items.map((i) => i.id)).toEqual(["c", "d"]);

    const page3 = await catalog.listItems({
      limit: 2,
      cursor: page2.nextCursor,
    });
    expect(page3.items.map((i) => i.id)).toEqual(["e"]);
    expect(page3.nextCursor).toBeUndefined();
  });

  it("resolves getItem by id, by server.name, and by name@version base", async () => {
    const catalog = createCatalog([
      source("first-party", [item("github", "github@1.0")]),
    ]);
    expect((await catalog.getItem("github@1.0"))?.id).toBe("github@1.0");
    expect((await catalog.getItem("github"))?.id).toBe("github@1.0");
    expect((await catalog.getItem("github@9.9"))?.id).toBe("github@1.0");
    expect(await catalog.getItem("missing")).toBeNull();
  });

  it("isolates a failing source — the others still return", async () => {
    const catalog = createCatalog(
      [failingSource("community"), source("first-party", [item("airtable")])],
      { maxAttempts: 1 },
    );
    const { items } = await catalog.listItems();
    expect(items.map((i) => i.id)).toEqual(["airtable"]);
  });

  it("returns an empty result with no sources", async () => {
    const catalog = createCatalog([]);
    expect(await catalog.listItems()).toEqual({ items: [], totalCount: 0 });
  });
});
