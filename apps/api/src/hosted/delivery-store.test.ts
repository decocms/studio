import { describe, expect, it } from "bun:test";
import {
  bareEtag,
  CACHE_DRAFT,
  createS3DeliveryStore,
  deliveryKeys,
  listRevisionShas,
  newDraftSlug,
  ObjectChangedError,
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

describe("createS3DeliveryStore: conditional writes", () => {
  /** An S3 endpoint that keeps one object and checks If-Match / If-None-Match as R2 does. */
  function s3Endpoint() {
    let etag: string | null = null;
    let n = 0;
    const seen: Array<Record<string, string | null>> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        await req.arrayBuffer();
        const ifMatch = req.headers.get("if-match");
        const ifNoneMatch = req.headers.get("if-none-match");
        seen.push({ ifMatch, ifNoneMatch });
        if (
          (ifMatch !== null && ifMatch !== etag) ||
          (ifNoneMatch === "*" && etag !== null)
        ) {
          return new Response(
            "<Error><Code>PreconditionFailed</Code><Message>At least one of the pre-conditions you specified did not hold</Message></Error>",
            { status: 412, headers: { "content-type": "application/xml" } },
          );
        }
        etag = `"e${++n}"`;
        return new Response(null, { status: 200, headers: { ETag: etag } });
      },
    });
    const store = createS3DeliveryStore({
      endpoint: `http://127.0.0.1:${server.port}`,
      bucket: "delivery",
      accessKeyId: "local",
      secretAccessKey: "local",
    });
    return { store, seen, stop: () => server.stop(true) };
  }

  it("sends the condition and answers ObjectChangedError when it no longer holds", async () => {
    const { store, seen, stop } = s3Endpoint();
    try {
      const key = deliveryKeys.draft("acme", newDraftSlug());
      const created = await store.putJson(key, {}, CACHE_DRAFT, undefined, {
        ifNoneMatch: "*",
      });
      expect(created.etag).toBe('"e1"');
      await expect(
        store.putJson(key, {}, CACHE_DRAFT, undefined, { ifNoneMatch: "*" }),
      ).rejects.toBeInstanceOf(ObjectChangedError);
      const next = await store.putJson(key, { a: 1 }, CACHE_DRAFT, undefined, {
        ifMatch: created.etag!,
      });
      expect(next.etag).toBe('"e2"');
      await expect(
        store.putJson(key, { a: 2 }, CACHE_DRAFT, undefined, {
          ifMatch: created.etag!,
        }),
      ).rejects.toBeInstanceOf(ObjectChangedError);
      // Without a condition it writes whatever is there (publish, releases).
      await store.putJson(key, { a: 3 }, CACHE_DRAFT);
      expect(seen.map((s) => s.ifMatch ?? s.ifNoneMatch)).toEqual([
        "*",
        "*",
        '"e1"',
        '"e1"',
        null,
      ]);
    } finally {
      stop();
    }
  });
});
