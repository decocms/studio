import { describe, expect, it } from "bun:test";
import { blockNameFromFile } from "@decocms/blocks/protocol";
import {
  bareEtag,
  CACHE_DRAFT,
  createS3DeliveryStore,
  deliveryKeys,
  draftFileName,
  newDraftSlug,
  ObjectChangedError,
} from "./delivery-store";

const REVISION = "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55";
const HASH = "D8NyAZf7d5YahxJT5yN79A";

describe("deliveryKeys", () => {
  it("builds the object keys under the site's prefix", () => {
    const slug = newDraftSlug();
    expect(deliveryKeys.latest("acme")).toBe("sites/acme/latest.json");
    expect(deliveryKeys.block("acme", HASH)).toBe(
      `sites/acme/blocks/${HASH}.json`,
    );
    expect(deliveryKeys.revisionIndex("acme", REVISION)).toBe(
      `sites/acme/revisions/${REVISION}/index.json`,
    );
    expect(deliveryKeys.revisionMeta("acme", REVISION)).toBe(
      `sites/acme/revisions/${REVISION}/meta.json`,
    );
    expect(deliveryKeys.draftIndex("acme", slug)).toBe(
      `sites/acme/drafts/${slug}/index.json`,
    );
    expect(deliveryKeys.draftFile("acme", slug, "pages/Home")).toBe(
      `sites/acme/drafts/${slug}/pages%2FHome.json`,
    );
  });

  it("writes the block named index where it can't be the draft index", () => {
    const slug = newDraftSlug();
    expect(draftFileName("index")).toBe("%69ndex.json");
    expect(blockNameFromFile(draftFileName("index"))).toBe("index");
    expect(deliveryKeys.draftFile("acme", slug, "index")).not.toBe(
      deliveryKeys.draftIndex("acme", slug),
    );
    // Any other spelling keeps the protocol's file name.
    expect(draftFileName("Index")).toBe("Index.json");
    expect(blockNameFromFile(draftFileName("a b/c"))).toBe("a b/c");
  });

  it("refuses a site, hash, revision, slug or name that could leave the prefix", () => {
    const slug = newDraftSlug();
    expect(() => deliveryKeys.latest("../acme")).toThrow();
    expect(() => deliveryKeys.latest("Acme")).toThrow();
    expect(() => deliveryKeys.block("acme", "../x")).toThrow();
    expect(() => deliveryKeys.block("acme", `${HASH}x`)).toThrow();
    expect(() => deliveryKeys.block("acme", "a/b".padEnd(22, "a"))).toThrow();
    expect(() => deliveryKeys.revisionIndex("acme", "main")).toThrow();
    expect(() => deliveryKeys.revisionIndex("acme", "a".repeat(40))).toThrow();
    expect(() => deliveryKeys.draftIndex("acme", "x/../y")).toThrow();
    expect(() => deliveryKeys.draftFile("acme", "x/../y", "a")).toThrow();
    expect(() => deliveryKeys.draftFile("acme", slug, "")).toThrow();
    expect(() => deliveryKeys.draftFile("acme", slug, ".hidden")).toThrow();
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
      const key = deliveryKeys.draftIndex("acme", newDraftSlug());
      const created = await store.putJson(key, {}, CACHE_DRAFT, {
        ifNoneMatch: "*",
      });
      expect(created.etag).toBe('"e1"');
      await expect(
        store.putJson(key, {}, CACHE_DRAFT, { ifNoneMatch: "*" }),
      ).rejects.toBeInstanceOf(ObjectChangedError);
      const next = await store.putJson(key, { a: 1 }, CACHE_DRAFT, {
        ifMatch: created.etag!,
      });
      expect(next.etag).toBe('"e2"');
      await expect(
        store.putJson(key, { a: 2 }, CACHE_DRAFT, {
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

describe("createS3DeliveryStore: conditional reads", () => {
  it("sends If-None-Match and answers notModified on a 304", async () => {
    const seen: Array<string | null> = [];
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const inm = req.headers.get("if-none-match");
        seen.push(inm);
        if (inm === '"e1"') return new Response(null, { status: 304 });
        return new Response('{"a":1}', {
          status: 200,
          headers: { ETag: '"e1"', "content-type": "application/json" },
        });
      },
    });
    const store = createS3DeliveryStore({
      endpoint: `http://127.0.0.1:${server.port}`,
      bucket: "delivery",
      accessKeyId: "local",
      secretAccessKey: "local",
    });
    try {
      const key = deliveryKeys.latest("acme");
      expect(await store.get(key)).toEqual({ text: '{"a":1}', etag: '"e1"' });
      expect(await store.get(key, { ifNoneMatch: '"e1"' })).toEqual({
        notModified: true,
      });
      expect(await store.get(key, { ifNoneMatch: '"e0"' })).toEqual({
        text: '{"a":1}',
        etag: '"e1"',
      });
      expect(seen).toEqual([null, '"e1"', '"e0"']);
    } finally {
      server.stop(true);
    }
  });
});
