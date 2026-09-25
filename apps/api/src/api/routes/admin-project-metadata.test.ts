import { describe, expect, it } from "bun:test";
import {
  authorizeProjectMetadataPatch,
  parseProjectMetadataPatch,
  selectSiteProjects,
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

describe("selectSiteProjects", () => {
  const owned = new Set(["acme", "acme-tanstack"]);

  it("lists a project whose persisted site slug the org owns", () => {
    expect(
      selectSiteProjects(
        [
          {
            id: "vir_1",
            title: "Acme",
            metadata: { siteSlug: "acme-tanstack", sandboxMap: {} },
          },
        ],
        owned,
      ),
    ).toEqual([
      {
        id: "vir_1",
        title: "Acme",
        siteSlug: "acme-tanstack",
        metadata: { analyticsSiteSlug: null },
      },
    ]);
  });

  it("lists a project imported before siteSlug was persisted, by its title", () => {
    const [project] = selectSiteProjects(
      [
        {
          id: "vir_2",
          title: "Acme-Tanstack",
          metadata: { fastPreview: true },
        },
      ],
      owned,
    );
    expect(project?.siteSlug).toBe("acme-tanstack");
  });

  it("skips projects whose slug the org does not own", () => {
    expect(
      selectSiteProjects(
        [
          { id: "vir_3", title: "Connection Manager", metadata: null },
          { id: "vir_4", title: "other", metadata: { siteSlug: "other" } },
        ],
        owned,
      ),
    ).toEqual([]);
  });

  it("keeps a project with an override even when its slug is unowned", () => {
    const [project] = selectSiteProjects(
      [
        {
          id: "vir_5",
          title: "legacy",
          metadata: { analyticsSiteSlug: "released" },
        },
      ],
      owned,
    );
    expect(project?.metadata).toEqual({ analyticsSiteSlug: "released" });
  });
});
