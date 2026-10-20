import { expect, test } from "bun:test";
import { InMemoryModelListCache } from "./model-list-cache";

test("chat and Decisions catalogs are independent and invalidate together within one organization", async () => {
  const cache = new InMemoryModelListCache();
  try {
    await cache.set("org-a", "openrouter", []);
    expect(await cache.get("org-a", "openrouter:decisions")).toBeNull();
    await cache.set("org-a", "openrouter:decisions", []);
    await cache.set("org-b", "openrouter:decisions", []);
    expect(await cache.get("org-a", "openrouter")).toEqual([]);
    expect(await cache.get("org-a", "openrouter:decisions")).toEqual([]);

    await cache.invalidate("org-a", "openrouter");
    expect(await cache.get("org-a", "openrouter")).toBeNull();
    expect(await cache.get("org-a", "openrouter:decisions")).toBeNull();
    expect(await cache.get("org-b", "openrouter:decisions")).toEqual([]);
  } finally {
    cache.teardown();
  }
});
