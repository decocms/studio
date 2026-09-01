/** `paginateSkillCatalog` — pure list logic, so the unit tier. See TESTING.md. */

import { describe, expect, it } from "bun:test";
import { paginateSkillCatalog, type SkillCatalogEntry } from "./skill-catalog";

function entry(
  name: string,
  source = "home",
  description: string | null = null,
): SkillCatalogEntry {
  return {
    id: `${source}/${name}`,
    name,
    description,
    source,
    sandboxPath: `org/home/${name}`,
    volume: "home",
    path: name,
  };
}

const CATALOG = [
  entry("zulu"),
  entry("alpha", "public:core", "makes slides"),
  entry("mike", "repo:docs"),
  entry("bravo"),
];

describe("paginateSkillCatalog", () => {
  it("sorts alphabetically by name and walks the cursor to the end", () => {
    const first = paginateSkillCatalog(CATALOG, { limit: 2 });
    expect(first.skills.map((s) => s.name)).toEqual(["alpha", "bravo"]);
    expect(first.nextCursor).toBe("2");

    const second = paginateSkillCatalog(CATALOG, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.skills.map((s) => s.name)).toEqual(["mike", "zulu"]);
    expect(second.nextCursor).toBeUndefined();
  });

  it("breaks name ties on id so a cursor can't skip or repeat an entry", () => {
    const dupes = [entry("same", "repo:b"), entry("same", "public:a")];
    const page = paginateSkillCatalog(dupes, { limit: 1 });
    expect(page.skills[0]?.id).toBe("public:a/same");
    expect(
      paginateSkillCatalog(dupes, { limit: 1, cursor: page.nextCursor })
        .skills[0]?.id,
    ).toBe("repo:b/same");
  });

  it("searches name and description, case-insensitively", () => {
    expect(
      paginateSkillCatalog(CATALOG, { limit: 10, q: "SLIDES" }).skills.map(
        (s) => s.name,
      ),
    ).toEqual(["alpha"]);
  });

  it("filters by source without narrowing the chips", () => {
    const page = paginateSkillCatalog(CATALOG, { limit: 10, source: "home" });
    expect(page.skills.map((s) => s.name)).toEqual(["bravo", "zulu"]);
    expect(page.sources).toEqual([
      { source: "home", count: 2 },
      { source: "public:core", count: 1 },
      { source: "repo:docs", count: 1 },
    ]);
  });

  it("keeps a source charted at 0 when the search empties it", () => {
    const page = paginateSkillCatalog(CATALOG, { limit: 10, q: "zulu" });
    expect(page.sources).toEqual([
      { source: "home", count: 1 },
      { source: "public:core", count: 0 },
      { source: "repo:docs", count: 0 },
    ]);
  });

  it("clamps a junk cursor and an oversized limit", () => {
    expect(
      paginateSkillCatalog(CATALOG, { limit: 1e6, cursor: "-5" }).skills,
    ).toHaveLength(4);
    expect(
      paginateSkillCatalog(CATALOG, { limit: 10, cursor: "nonsense" }).skills,
    ).toHaveLength(4);
  });

  it("reports no next page when the cursor lands past the end", () => {
    const page = paginateSkillCatalog(CATALOG, { limit: 2, cursor: "99" });
    expect(page.skills).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});
