import { describe, expect, it } from "bun:test";
import { filterItems, matchesSearch } from "./search";
import type { CatalogItem } from "./types";

function item(
  name: string,
  opts: {
    title?: string;
    description?: string;
    serverTitle?: string;
    tags?: string[];
    categories?: string[];
  } = {},
): CatalogItem {
  return {
    id: name,
    title: opts.title ?? name,
    created_at: "",
    updated_at: "",
    server: {
      name,
      title: opts.serverTitle,
      description: opts.description,
    },
    _meta: { "mcp.mesh": { tags: opts.tags, categories: opts.categories } },
  };
}

describe("matchesSearch", () => {
  const airtable = item("airtable", {
    title: "Airtable",
    description: "Spreadsheet database",
    serverTitle: "Airtable Server",
  });

  it("returns true for an empty/whitespace term", () => {
    expect(matchesSearch(airtable, "")).toBe(true);
    expect(matchesSearch(airtable, "   ")).toBe(true);
  });

  it("matches case-insensitively across title, description, name, server.title", () => {
    expect(matchesSearch(airtable, "AIR")).toBe(true); // title/name
    expect(matchesSearch(airtable, "spreadsheet")).toBe(true); // description
    expect(matchesSearch(airtable, "server")).toBe(true); // server.title
  });

  it("returns false when no field contains the term", () => {
    expect(matchesSearch(airtable, "postgres")).toBe(false);
  });

  it("does not throw when optional fields (description/server.title) are absent", () => {
    const bare: CatalogItem = {
      id: "x",
      title: "x",
      created_at: "",
      updated_at: "",
      server: { name: "only-a-name" },
    };
    expect(matchesSearch(bare, "only")).toBe(true);
    expect(matchesSearch(bare, "missing")).toBe(false);
  });
});

describe("filterItems", () => {
  const items = [
    item("airtable", { tags: ["db", "oauth"], categories: ["data"] }),
    item("github", { tags: ["dev", "oauth"], categories: ["dev"] }),
    item("postgres", { tags: ["db"], categories: ["data"] }),
  ];

  it("filters by free-text search", () => {
    expect(filterItems(items, { search: "git" }).map((i) => i.id)).toEqual([
      "github",
    ]);
  });

  it("applies tag filters with AND semantics", () => {
    expect(
      filterItems(items, { tags: ["db", "oauth"] }).map((i) => i.id),
    ).toEqual(["airtable"]);
  });

  it("applies category filters with AND semantics", () => {
    expect(
      filterItems(items, { categories: ["data"] }).map((i) => i.id),
    ).toEqual(["airtable", "postgres"]);
  });

  it("matches an exact server.name via `name`", () => {
    expect(filterItems(items, { name: "postgres" }).map((i) => i.id)).toEqual([
      "postgres",
    ]);
  });

  it("ANDs all provided filters together", () => {
    expect(
      filterItems(items, {
        search: "a",
        tags: ["db"],
        categories: ["data"],
      }).map((i) => i.id),
    ).toEqual(["airtable"]);
  });

  it("returns everything for an empty query", () => {
    expect(filterItems(items, {})).toHaveLength(3);
  });
});
