import { describe, expect, it } from "bun:test";
import {
  buildDuplicatePage,
  buildEmptyPage,
  generateUniquePageBlockKey,
  nextUniqueBlockKey,
  nextUniqueName,
  nextUniquePagePath,
} from "./content-mutations";

describe("content-mutations", () => {
  it("nextUniqueName appends (copy) suffixes", () => {
    const taken = new Set(["Home (copy)"]);
    expect(nextUniqueName(taken, "Home")).toBe("Home (copy 2)");
  });

  it("nextUniquePagePath avoids normalized path collisions", () => {
    const taken = new Set(["/about-copy"]);
    expect(nextUniquePagePath(taken, "/about")).toBe("/about-copy-2");
  });

  it("nextUniqueBlockKey avoids decofile key collisions", () => {
    const decofile = { Header_copy: { name: "x" } };
    expect(nextUniqueBlockKey(decofile, "Header")).toBe("Header_copy_2");
  });

  it("buildDuplicatePage uses a fresh pages-* key", () => {
    const { key, data } = buildDuplicatePage({
      source: {
        __resolveType: "website/pages/Page.tsx",
        name: "Home",
        path: "/",
        sections: [],
      },
      pages: [{ key: "pages-home-abc123456789", name: "Home", path: "/" }],
      newName: "Copy",
      newPath: "/copy",
    });
    expect(key).toMatch(/^pages-Copy-/);
    expect(data.name).toBe("Copy");
    expect(data.path).toBe("/copy");
  });

  it("buildEmptyPage matches createEmptyPageBlock shape", () => {
    expect(buildEmptyPage("About", "/about").path).toBe("/about");
  });

  it("generateUniquePageBlockKey returns a free key", () => {
    const decofile: Record<string, unknown> = {};
    const key = generateUniquePageBlockKey(decofile, "New");
    expect(key.startsWith("pages-New-")).toBe(true);
    expect(Object.hasOwn(decofile, key)).toBe(false);
  });
});
