import { describe, expect, it } from "bun:test";
import {
  authorizeProjectMetadataPatch,
  listSiteProjects,
  parseProjectMetadataPatch,
  pickProjectMetadata,
} from "./admin-project-metadata";

describe("parseProjectMetadataPatch", () => {
  it("normalizes a value to set", () => {
    expect(parseProjectMetadataPatch({ analyticsSiteSlug: " Acme " })).toEqual({
      set: { analyticsSiteSlug: "acme" },
      unset: [],
    });
  });

  it("turns null into a removal", () => {
    expect(parseProjectMetadataPatch({ analyticsSiteSlug: null })).toEqual({
      set: {},
      unset: ["analyticsSiteSlug"],
    });
  });

  it("rejects keys outside the allowlist", () => {
    expect(parseProjectMetadataPatch({ siteSlug: "acme" })).toBeNull();
    expect(parseProjectMetadataPatch({ sandboxMap: {} })).toBeNull();
    expect(
      parseProjectMetadataPatch({ analyticsSiteSlug: "acme", siteSlug: "x" }),
    ).toBeNull();
  });

  it("rejects an invalid value", () => {
    expect(parseProjectMetadataPatch({ analyticsSiteSlug: "a/b" })).toBeNull();
    expect(parseProjectMetadataPatch({ analyticsSiteSlug: "" })).toBeNull();
    expect(parseProjectMetadataPatch({ analyticsSiteSlug: 1 })).toBeNull();
    expect(
      parseProjectMetadataPatch({ analyticsSiteSlug: "a".repeat(61) }),
    ).toBeNull();
  });

  it("rejects a body with nothing to change", () => {
    expect(parseProjectMetadataPatch({})).toBeNull();
    expect(parseProjectMetadataPatch(null)).toBeNull();
    expect(parseProjectMetadataPatch([])).toBeNull();
  });
});

describe("authorizeProjectMetadataPatch", () => {
  const ownedBy =
    (...slugs: string[]) =>
    async (slug: string) =>
      slugs.includes(slug);

  it("allows an analytics site the org owns", async () => {
    expect(
      await authorizeProjectMetadataPatch(
        { set: { analyticsSiteSlug: "acme" }, unset: [] },
        { isSiteOwned: ownedBy("acme") },
      ),
    ).toBeNull();
  });

  it("refuses an analytics site the org does not own", async () => {
    expect(
      await authorizeProjectMetadataPatch(
        { set: { analyticsSiteSlug: "other" }, unset: [] },
        { isSiteOwned: ownedBy("acme") },
      ),
    ).toBe("site_not_owned");
  });

  it("lets a removal through without an ownership check", async () => {
    expect(
      await authorizeProjectMetadataPatch(
        { set: {}, unset: ["analyticsSiteSlug"] },
        { isSiteOwned: ownedBy() },
      ),
    ).toBeNull();
  });
});

describe("pickProjectMetadata", () => {
  it("returns only the editable keys, absent ones as null", () => {
    expect(
      pickProjectMetadata({ siteSlug: "acme-tanstack", sandboxMap: {} }),
    ).toEqual({ analyticsSiteSlug: null });
    expect(pickProjectMetadata({ analyticsSiteSlug: "acme" })).toEqual({
      analyticsSiteSlug: "acme",
    });
    expect(pickProjectMetadata(null)).toEqual({ analyticsSiteSlug: null });
  });
});

describe("listSiteProjects", () => {
  const owned = new Set(["acme", "acme-tanstack"]);

  it("lists a project whose slug is only its title", () => {
    expect(
      listSiteProjects(
        [{ id: "vir_1", title: "acme-tanstack", metadata: null }],
        owned,
      ),
    ).toEqual([
      {
        id: "vir_1",
        title: "acme-tanstack",
        siteSlug: "acme-tanstack",
        metadata: { analyticsSiteSlug: null },
      },
    ]);
  });

  it("prefers metadata.siteSlug over the title", () => {
    expect(
      listSiteProjects(
        [
          {
            id: "vir_1",
            title: "Acme Store",
            metadata: { siteSlug: "acme", analyticsSiteSlug: "acme-tanstack" },
          },
        ],
        owned,
      ),
    ).toEqual([
      {
        id: "vir_1",
        title: "Acme Store",
        siteSlug: "acme",
        metadata: { analyticsSiteSlug: "acme-tanstack" },
      },
    ]);
  });

  it("skips projects whose slug the org does not own", () => {
    expect(
      listSiteProjects(
        [
          { id: "vir_1", title: "Support agent", metadata: {} },
          { id: "vir_2", title: "other", metadata: { siteSlug: "other" } },
        ],
        owned,
      ),
    ).toEqual([]);
  });
});
