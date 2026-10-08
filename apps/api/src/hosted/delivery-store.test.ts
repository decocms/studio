import { describe, expect, it } from "bun:test";
import {
  bareEtag,
  deliveryKeys,
  listRevisionShas,
  newDraftSlug,
} from "./delivery-store";
import { memoryDeliveryStore } from "./hosted-test-helpers";

const SHA = "a".repeat(40);

describe("deliveryKeys", () => {
  it("builds the three object keys under the site's prefix", () => {
    const slug = newDraftSlug();
    expect(deliveryKeys.latest("acme")).toBe("sites/acme/latest.json");
    expect(deliveryKeys.revision("acme", SHA)).toBe(
      `sites/acme/revisions/${SHA}.json`,
    );
    expect(deliveryKeys.draft("acme", slug)).toBe(
      `sites/acme/drafts/${slug}.json`,
    );
  });

  it("refuses a site, revision or slug that could leave the prefix", () => {
    expect(() => deliveryKeys.latest("../acme")).toThrow();
    expect(() => deliveryKeys.latest("Acme")).toThrow();
    expect(() => deliveryKeys.revision("acme", "main")).toThrow();
    expect(() => deliveryKeys.revision("acme", "A".repeat(40))).toThrow();
    expect(() => deliveryKeys.draft("acme", "x/../y")).toThrow();
  });
});

describe("newDraftSlug", () => {
  it("is 22 base64url characters and unique", () => {
    const a = newDraftSlug();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newDraftSlug()).not.toBe(a);
  });
});

describe("bareEtag", () => {
  it("drops the quotes and the weak prefix", () => {
    expect(bareEtag('"abc"')).toBe("abc");
    expect(bareEtag('W/"abc"')).toBe("abc");
    expect(bareEtag(null)).toBeNull();
  });
});

describe("listRevisionShas", () => {
  it("lists only the site's revision objects", async () => {
    const { store } = memoryDeliveryStore();
    await store.putJson(deliveryKeys.revision("acme", SHA), {}, "x");
    await store.putJson(deliveryKeys.latest("acme"), {}, "x");
    await store.putJson(
      deliveryKeys.revision("acme-2", "b".repeat(40)),
      {},
      "x",
    );
    expect([...(await listRevisionShas(store, "acme"))]).toEqual([SHA]);
  });
});
