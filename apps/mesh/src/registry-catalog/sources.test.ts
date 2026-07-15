import { describe, expect, it } from "bun:test";
import {
  firstPartyJsonSource,
  normalizeCatalog,
  toCatalogItem,
} from "./sources";

describe("toCatalogItem", () => {
  it("derives id/title from a bare { server } envelope", () => {
    const item = toCatalogItem({ server: { name: "airtable" } });
    expect(item).not.toBeNull();
    expect(item?.id).toBe("airtable");
    expect(item?.title).toBe("airtable");
  });

  it("builds a name@version id when the server has a version", () => {
    const item = toCatalogItem({ server: { name: "exa", version: "3.1.1" } });
    expect(item?.id).toBe("exa@3.1.1");
  });

  it("passes through explicit top-level fields (LIST shape)", () => {
    const item = toCatalogItem({
      id: "custom-id",
      title: "Custom Title",
      created_at: "2026-01-01",
      updated_at: "2026-02-02",
      server: { name: "x" },
    });
    expect(item?.id).toBe("custom-id");
    expect(item?.title).toBe("Custom Title");
    expect(item?.created_at).toBe("2026-01-01");
    expect(item?.updated_at).toBe("2026-02-02");
  });

  it("falls back to the official-registry meta timestamps", () => {
    const item = toCatalogItem({
      server: { name: "x" },
      _meta: {
        "io.modelcontextprotocol.registry/official": {
          publishedAt: "2026-03-03",
          updatedAt: "2026-04-04",
        },
      },
    });
    expect(item?.created_at).toBe("2026-03-03");
    expect(item?.updated_at).toBe("2026-04-04");
  });

  it("returns null when server.name is missing or the value is not an object", () => {
    expect(toCatalogItem({ server: {} })).toBeNull();
    expect(toCatalogItem({ server: { name: "" } })).toBeNull();
    expect(toCatalogItem({})).toBeNull();
    expect(toCatalogItem("nope")).toBeNull();
    expect(toCatalogItem(null)).toBeNull();
  });
});

describe("normalizeCatalog", () => {
  it("accepts a bare array", () => {
    const items = normalizeCatalog([
      { server: { name: "a" } },
      { server: { name: "b" } },
    ]);
    expect(items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("unwraps { items } and { servers } envelopes", () => {
    expect(
      normalizeCatalog({ items: [{ server: { name: "a" } }] }),
    ).toHaveLength(1);
    expect(
      normalizeCatalog({ servers: [{ server: { name: "b" } }] }),
    ).toHaveLength(1);
  });

  it("skips invalid elements", () => {
    const items = normalizeCatalog([
      { server: { name: "ok" } },
      { server: {} },
      "junk",
    ]);
    expect(items.map((i) => i.id)).toEqual(["ok"]);
  });

  it("returns [] for an unrecognized shape", () => {
    expect(normalizeCatalog({ nope: true })).toEqual([]);
  });
});

describe("firstPartyJsonSource", () => {
  function fakeFetch(body: unknown, status = 200): typeof fetch {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;
  }

  it("fetches + normalizes a flat catalog", async () => {
    const source = firstPartyJsonSource("https://example.com/registry.json", {
      fetchImpl: fakeFetch([{ server: { name: "airtable" } }]),
    });
    const items = await source.load();
    expect(items.map((i) => i.id)).toEqual(["airtable"]);
    expect(source.id).toBe("first-party");
  });

  it("throws on a non-ok response", async () => {
    const source = firstPartyJsonSource("https://example.com/registry.json", {
      fetchImpl: fakeFetch({}, 503),
    });
    await expect(source.load()).rejects.toThrow("503");
  });
});
