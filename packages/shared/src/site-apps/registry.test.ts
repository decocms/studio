import { describe, expect, it } from "bun:test";
import {
  findSiteApp,
  siteAppBlockKey,
  siteAppRegistry,
  type SiteTechnology,
} from "./index";

const TECHNOLOGIES: SiteTechnology[] = ["deno", "tanstack"];

describe.each(TECHNOLOGIES)("%s registry", (technology) => {
  const registry = siteAppRegistry(technology);

  it("is not empty", () => {
    expect(registry.length).toBeGreaterThan(0);
  });

  it("keys every app as <vendor>-<app>, which is what findSiteApp and the block agree on", () => {
    for (const entry of registry) {
      expect(entry.blockKey).toBe(siteAppBlockKey(entry.vendor, entry.app));
      expect(findSiteApp(technology, entry.blockKey)).toBe(entry);
    }
  });

  it("has no duplicate block keys", () => {
    const keys = registry.map((entry) => entry.blockKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gives every entry a title and a category to list it under", () => {
    for (const entry of registry) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect(entry.category.length).toBeGreaterThan(0);
    }
  });
});

describe("tanstack registry", () => {
  it("names a package and its registry export for every app — an install needs both", () => {
    for (const entry of siteAppRegistry("tanstack")) {
      expect(entry.npm?.name).toBe(`@decocms/apps-${entry.app}`);
      expect(entry.npm?.registryExport).toMatch(
        /^[A-Z][A-Z0-9_]*_REGISTRY_ENTRY$/,
      );
    }
  });
});

describe("deno registry", () => {
  it("names no package — the `apps/` import-map alias already covers every app", () => {
    for (const entry of siteAppRegistry("deno")) {
      expect(entry.npm).toBeUndefined();
    }
  });

  it("excludes the apps the CMS deliberately does not install", () => {
    const apps = siteAppRegistry("deno").map((entry) => entry.app);
    for (const excluded of ["decohub", "records"]) {
      expect(apps).not.toContain(excluded);
    }
  });
});
