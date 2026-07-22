import { describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import type { BrandContext } from "@/storage/types";
import { brandManagerAgent } from "./brand-manager";

function brand(overrides: Partial<BrandContext>): BrandContext {
  return {
    id: "brand_1",
    organizationId: "org_1",
    name: "Brand",
    domain: "example.com",
    overview: "",
    logo: null,
    favicon: null,
    ogImage: null,
    fonts: null,
    colors: null,
    images: null,
    metadata: null,
    archivedAt: null,
    isDefault: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function ctxWithBrands(brands: BrandContext[]): StudioContext {
  return {
    storage: { brandContext: { list: async () => brands } },
  } as unknown as StudioContext;
}

describe("brandManagerAgent checklist", () => {
  const completeBrandProfile = brandManagerAgent.checklist.find(
    (item) => item.label === "Complete your brand profile",
  );
  if (!completeBrandProfile) throw new Error("checklist item not found");

  test("checks the default brand, not the oldest one, when the org has several", async () => {
    const oldestIncomplete = brand({ id: "brand_old", isDefault: false });
    const defaultComplete = brand({
      id: "brand_default",
      isDefault: true,
      logo: "https://example.com/logo.png",
      colors: { primary: "#000" },
      fonts: { heading: "Inter" },
    });

    const completed = await completeBrandProfile.isCompleted({
      orgId: "org_1",
      ctx: ctxWithBrands([oldestIncomplete, defaultComplete]),
    });

    expect(completed).toBe(true);
  });

  test("falls back to the oldest brand when none is marked default", async () => {
    const onlyBrand = brand({ id: "brand_1", isDefault: false, logo: null });

    const completed = await completeBrandProfile.isCompleted({
      orgId: "org_1",
      ctx: ctxWithBrands([onlyBrand]),
    });

    expect(completed).toBe(false);
  });
});
