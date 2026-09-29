import { describe, expect, test } from "bun:test";
import {
  SITE_TEMPLATES,
  SiteRepoNameSchema,
  SiteTemplateIdSchema,
  siteTemplate,
} from "./site-templates";

describe("site templates", () => {
  test("the id schema covers exactly the allowlisted templates", () => {
    expect([...SiteTemplateIdSchema.options].sort()).toEqual(
      SITE_TEMPLATES.map((t) => t.id).sort(),
    );
  });

  test("resolves an id to its template repository", () => {
    expect(siteTemplate("storefront").repo).toEqual({
      owner: "deco-sites",
      name: "storefront-tanstack",
    });
  });
});

describe("SiteRepoNameSchema", () => {
  test("accepts lower-case slugs and trims whitespace", () => {
    expect(SiteRepoNameSchema.parse("my-store")).toBe("my-store");
    expect(SiteRepoNameSchema.parse("  a1  ")).toBe("a1");
    expect(SiteRepoNameSchema.parse("x")).toBe("x");
  });

  test("rejects empty, oversized and non-slug names", () => {
    for (const name of [
      "",
      "   ",
      "My-Store",
      "-store",
      "store-",
      "my_store",
      "my.store",
      "..",
      "a/b",
      "a".repeat(101),
    ]) {
      expect(SiteRepoNameSchema.safeParse(name).success).toBe(false);
    }
    expect(SiteRepoNameSchema.safeParse("a".repeat(100)).success).toBe(true);
  });
});
