/**
 * The hosted CMS's content-protocol storage, through the protocol's real
 * handler and the route's dispatcher (`cms-rpc.ts`): the live index with
 * the draft's files overlaid, saves against the draft files only, bodies
 * read only when asked for, conflicts from the save's own read, partial
 * saves answering what landed.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { TOMBSTONE_VERSION } from "@decocms/blocks/protocol";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { blockVersion } from "./block-version";
import { readDraftFile, readDraftIndex, updateDraftIndex } from "./cms-drafts";
import { clearRevisionCache } from "./cms-release";
import { applyNamesOf, dispatchCmsRpc } from "./cms-rpc";
import {
  clearSchemaCache,
  createCmsStorage,
  targetsFirst,
} from "./cms-storage";
import {
  deleteFile,
  seedDraftFile,
  seedRelease,
  setFile,
} from "./cms-test-helpers";
import {
  CACHE_SCHEMA,
  CONDITIONAL_PUT_TIMEOUT_MS,
  DeliveryUnavailableError,
  deliveryKeys,
  newDraftSlug,
} from "./delivery-store";
import { memoryDeliveryStore } from "./hosted-test-helpers";

const SITE = "acme";
const R1 = "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55";

beforeEach(() => {
  clearRevisionCache();
  clearSchemaCache();
});

type Answer = {
  id?: string | number;
  result?: Record<string, unknown> & {
    blocks?: Record<string, unknown>;
    versions?: Record<string, string | null>;
    revision?: string;
    resolvedRef?: string | null;
    notModified?: boolean;
    missing?: string[];
    entries?: Record<string, unknown>;
    draft?: Record<string, unknown>;
  };
  error?: { code: number; message?: string; data?: Record<string, unknown> };
};

function setup(userId = "usr_ana", now = 1793800000) {
  const delivery = memoryDeliveryStore();
  const slug = newDraftSlug();
  const send = async (body: unknown, who = userId): Promise<unknown> => {
    const storage = createCmsStorage({
      store: delivery.store,
      site: SITE,
      slug,
      userId: who,
      via: "studio",
      applyNames: applyNamesOf(body),
      now: () => now,
    });
    const handler = createContentHandler(storage, {
      maxCommitAttempts: 1,
      bodyCacheBytes: 0,
    });
    const request = new Request("http://x/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const res = await dispatchCmsRpc(storage, handler, request, body);
    return res.json();
  };
  const call = async (method: string, params: unknown = {}, who = userId) =>
    (await send({ jsonrpc: "2.0", id: 1, method, params }, who)) as Answer;
  return { delivery, slug, send, call };
}

/** Reads the store saw, of `blocks/` objects. */
const blockReads = (reads: string[]) =>
  reads.filter((r) => r.includes("/blocks/"));

describe("snapshot (blocks.list, cms.index)", () => {
  it("is the live index with the draft's files on top, versioned by blockVersion", async () => {
    const { delivery, slug, call } = setup();
    await seedRelease(delivery.store, SITE, R1, {
      header: { t: "prod" },
      footer: { t: "prod" },
      banner: { t: "prod" },
    });
    await seedDraftFile(
      delivery.store,
      SITE,
      slug,
      "header",
      setFile({ t: "draft" }),
    );
    await seedDraftFile(delivery.store, SITE, slug, "banner", deleteFile());
    const { result } = await call("blocks.list");
    expect(result?.blocks).toEqual({
      footer: { t: "prod" },
      header: { t: "draft" },
    });
    expect(result?.versions).toEqual({
      footer: blockVersion({ t: "prod" }),
      header: blockVersion({ t: "draft" }),
    });
    expect(result?.revision).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(result?.resolvedRef).toBe(R1);
  });

  it("cms.index reads no block body, and answers notModified on the same token", async () => {
    const { delivery, slug, call } = setup();
    await seedRelease(delivery.store, SITE, R1, {
      home: {
        __resolveType: "website/pages/Page.tsx",
        path: "/",
        s: [{ __resolveType: "header" }],
      },
      header: { __resolveType: "site/sections/Header.tsx" },
      gone: { t: 1 },
      CMS: { __resolveType: "cms-settings" },
    });
    await seedDraftFile(
      delivery.store,
      SITE,
      slug,
      "promo",
      setFile(
        {
          __resolveType: "website/pages/Page.tsx",
          path: "/promo",
          h: { __resolveType: "header" },
        },
        "usr_bob",
        7,
      ),
    );
    await seedDraftFile(
      delivery.store,
      SITE,
      slug,
      "gone",
      deleteFile("usr_cy", 8),
    );
    delivery.reads.length = 0;
    const first = await call("cms.index");
    expect(blockReads(delivery.reads)).toEqual([]);
    expect(first.result?.notModified).toBe(false);
    expect(first.result?.resolvedRef).toBe(R1);
    expect(first.result?.sequence).toBe(1);
    expect(first.result?.entries).toEqual({
      home: {
        version: blockVersion({
          __resolveType: "website/pages/Page.tsx",
          path: "/",
          s: [{ __resolveType: "header" }],
        }),
        meta: { type: "website/pages/Page.tsx", path: "/", refs: ["header"] },
      },
      header: {
        version: blockVersion({ __resolveType: "site/sections/Header.tsx" }),
        meta: { type: "site/sections/Header.tsx" },
      },
      // The settings block's inline body stays in the index, not here.
      CMS: {
        version: blockVersion({ __resolveType: "cms-settings" }),
        meta: { type: "cms-settings" },
      },
      promo: {
        version: blockVersion({
          __resolveType: "website/pages/Page.tsx",
          path: "/promo",
          h: { __resolveType: "header" },
        }),
        meta: {
          type: "website/pages/Page.tsx",
          path: "/promo",
          refs: ["header"],
        },
      },
    });
    expect(first.result?.draft).toEqual({
      promo: {
        operation: "set",
        version: blockVersion({
          __resolveType: "website/pages/Page.tsx",
          path: "/promo",
          h: { __resolveType: "header" },
        }),
        editor: { userId: "usr_bob", at: 7 },
      },
      gone: {
        operation: "delete",
        version: TOMBSTONE_VERSION,
        editor: { userId: "usr_cy", at: 8 },
      },
    });
    const again = await call("cms.index", {
      ifNoneMatch: first.result?.revision,
    });
    expect(again.result).toEqual({
      notModified: true,
      revision: first.result!.revision!,
    });
    // A save moves the token.
    await seedDraftFile(delivery.store, SITE, slug, "promo", setFile({ t: 2 }));
    const moved = await call("cms.index", {
      ifNoneMatch: first.result?.revision,
    });
    expect(moved.result?.notModified).toBe(false);
  });

  it("works before the first publish and before the draft index exists", async () => {
    const { call } = setup();
    const { result } = await call("blocks.list");
    expect(result?.blocks).toEqual({});
    expect(result?.resolvedRef).toBeNull();
    const index = await call("cms.index");
    expect(index.result).toMatchObject({
      resolvedRef: null,
      sequence: 0,
      entries: {},
      draft: {},
    });
  });

  it("a listed name whose file is missing, or holds a published marker, reads as production", async () => {
    const { delivery, slug, call } = setup();
    await seedRelease(delivery.store, SITE, R1, {
      a: { t: "prod" },
      b: { t: "prod" },
    });
    await updateDraftIndex(delivery.store, SITE, slug, () => ["a"]);
    await seedDraftFile(delivery.store, SITE, slug, "b", {
      operation: "published",
      revision: R1,
      version: blockVersion({ t: "prod" }),
    });
    const index = await call("cms.index");
    expect(index.result?.draft).toEqual({});
    expect(Object.keys(index.result?.entries ?? {}).sort()).toEqual(["a", "b"]);
  });
});

describe("cms.blocks", () => {
  it("answers draft bodies, else production bodies by hash, and lists what is missing", async () => {
    const { delivery, slug, call } = setup();
    await seedRelease(delivery.store, SITE, R1, {
      a: { t: "prod" },
      b: { t: "prod" },
      c: { t: "prod" },
    });
    await seedDraftFile(
      delivery.store,
      SITE,
      slug,
      "a",
      setFile({ t: "draft" }),
    );
    await seedDraftFile(delivery.store, SITE, slug, "c", deleteFile());
    delivery.reads.length = 0;
    const { result } = await call("cms.blocks", {
      names: ["a", "b", "c", "nope"],
    });
    expect(result?.blocks).toEqual({ a: { t: "draft" }, b: { t: "prod" } });
    expect(result?.versions).toEqual({
      a: blockVersion({ t: "draft" }),
      b: blockVersion({ t: "prod" }),
    });
    expect(result?.missing).toEqual(["c", "nope"]);
    // Only b's body, by its hash.
    expect(blockReads(delivery.reads)).toEqual([
      `get ${deliveryKeys.block(SITE, blockVersion({ t: "prod" }))}`,
    ]);
  });

  it("takes 1 to 50 names", async () => {
    const { call } = setup();
    expect((await call("cms.blocks", { names: [] })).error?.code).toBe(-32602);
    const many = Array.from({ length: 51 }, (_, i) => `b${i}`);
    expect((await call("cms.blocks", { names: many })).error?.code).toBe(
      -32602,
    );
    expect(
      (await call("cms.blocks", { names: many.slice(0, 50) })).result?.missing,
    ).toHaveLength(50);
    expect((await call("cms.blocks", {})).error?.code).toBe(-32602);
    expect((await call("cms.blocks", { names: [1] })).error?.code).toBe(-32602);
  });
});

describe("batches", () => {
  it("a batch mixing Studio and protocol methods answers every call, in order", async () => {
    const { delivery, send } = setup();
    await seedRelease(delivery.store, SITE, R1, { a: { t: 1 } });
    const answers = (await send([
      { jsonrpc: "2.0", id: "i", method: "cms.index", params: {} },
      { jsonrpc: "2.0", id: "s", method: "schema.get", params: {} },
      { jsonrpc: "2.0", id: "c", method: "changes.list", params: {} },
      {
        jsonrpc: "2.0",
        id: "b",
        method: "cms.blocks",
        params: { names: ["a"] },
      },
      { jsonrpc: "2.0", id: "x", method: "nope", params: {} },
    ])) as Answer[];
    expect(answers.map((a) => a.id)).toEqual(["i", "s", "c", "b", "x"]);
    expect(answers[0]?.result?.notModified).toBe(false);
    expect(answers[1]?.result).toBeDefined();
    expect(answers[2]?.result?.changes).toEqual({});
    expect(answers[3]?.result?.blocks).toEqual({ a: { t: 1 } });
    expect(answers[4]?.error?.code).toBe(-32601);
  });

  it("a batch over the limit is refused whole by the handler", async () => {
    const { send } = setup();
    const calls = Array.from({ length: 11 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i,
      method: "cms.index",
    }));
    const answer = (await send(calls)) as Answer;
    expect(answer.error?.code).toBe(-32007);
  });
});

describe("blocks.apply (the save)", () => {
  it("a new name goes into the draft index before its file", async () => {
    const { delivery, slug, call } = setup();
    await seedRelease(delivery.store, SITE, R1, { header: { t: "prod" } });
    delivery.log.length = 0;
    delivery.reads.length = 0;
    const { result } = await call("blocks.apply", {
      set: { header: { t: "mine" } },
      ifMatch: { header: null },
    });
    expect(result?.versions).toEqual({ header: blockVersion({ t: "mine" }) });
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.draftIndex(SITE, slug)}`,
      `put ${deliveryKeys.draftFile(SITE, slug, "header")}`,
    ]);
    // The save read the draft index and its own file only: no release, no body.
    expect(delivery.reads).toEqual([
      `get ${deliveryKeys.draftIndex(SITE, slug)}`,
      `get ${deliveryKeys.draftFile(SITE, slug, "header")}`,
    ]);
    expect(
      (await readDraftFile(delivery.store, SITE, slug, "header")).file,
    ).toEqual(setFile({ t: "mine" }));
  });

  it("an autosave of a listed name never touches the draft index", async () => {
    const { delivery, slug, call } = setup();
    await call("blocks.apply", { set: { a: { v: 1 } }, ifMatch: { a: null } });
    delivery.log.length = 0;
    const { result } = await call("blocks.apply", {
      set: { a: { v: 2 } },
      ifMatch: { a: blockVersion({ v: 1 }) },
    });
    expect(result?.versions).toEqual({ a: blockVersion({ v: 2 }) });
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.draftFile(SITE, slug, "a")}`,
    ]);
  });

  it("checks ifMatch against the draft only: production's copy is null", async () => {
    const { delivery, call } = setup();
    await seedRelease(delivery.store, SITE, R1, { header: { t: "prod" } });
    const first = await call("blocks.apply", {
      set: { header: { t: "a" } },
      ifMatch: { header: null },
    });
    expect(first.error).toBeUndefined();
    const stale = await call(
      "blocks.apply",
      { set: { header: { t: "b" } }, ifMatch: { header: null } },
      "usr_bob",
    );
    expect(stale.error?.code).toBe(-32002);
  });

  it("a mismatch writes nothing, and the conflict carries value, version and editor from the save's own read", async () => {
    const { delivery, slug, call } = setup();
    await seedDraftFile(
      delivery.store,
      SITE,
      slug,
      "header",
      setFile({ t: "theirs" }, "usr_bob", 1793800100),
    );
    await seedDraftFile(
      delivery.store,
      SITE,
      slug,
      "old",
      deleteFile("usr_cy", 1793800200),
    );
    delivery.log.length = 0;
    const answer = await call("blocks.apply", {
      set: { header: { t: "mine" }, fresh: { t: 1 } },
      delete: ["old"],
      ifMatch: { header: blockVersion({ t: "base" }), fresh: null, old: null },
    });
    expect(answer.error?.code).toBe(-32002);
    expect(answer.error?.data?.entries).toEqual({
      header: {
        expected: blockVersion({ t: "base" }),
        actual: blockVersion({ t: "theirs" }),
      },
      old: { expected: null, actual: TOMBSTONE_VERSION },
    });
    expect(answer.error?.data?.draft).toEqual({
      header: {
        block: { t: "theirs" },
        version: blockVersion({ t: "theirs" }),
        editor: { userId: "usr_bob", at: 1793800100 },
      },
      old: {
        block: null,
        version: TOMBSTONE_VERSION,
        editor: { userId: "usr_cy", at: 1793800200 },
      },
    });
    // All or nothing: not a single PUT.
    expect(delivery.log.filter((l) => l.startsWith("put"))).toEqual([]);
  });

  it("writes targets before referrers, then the deletes", async () => {
    const { delivery, slug, call } = setup();
    await seedRelease(delivery.store, SITE, R1, { z: { t: 1 }, y: { t: 1 } });
    delivery.log.length = 0;
    const answer = await call("blocks.apply", {
      set: {
        // home → footer → links; links is written first.
        home: { __resolveType: "page", s: [{ __resolveType: "footer" }] },
        footer: { __resolveType: "x", c: { __resolveType: "links" } },
        links: { __resolveType: "y" },
        alone: { t: 1 },
      },
      delete: ["z", "y"],
      ifMatch: {
        home: null,
        footer: null,
        links: null,
        alone: null,
        z: null,
        y: null,
      },
    });
    expect(answer.error).toBeUndefined();
    const puts = delivery.log.filter((l) => l.startsWith("put"));
    expect(puts).toEqual([
      `put ${deliveryKeys.draftIndex(SITE, slug)}`,
      `put ${deliveryKeys.draftFile(SITE, slug, "alone")}`,
      `put ${deliveryKeys.draftFile(SITE, slug, "links")}`,
      `put ${deliveryKeys.draftFile(SITE, slug, "footer")}`,
      `put ${deliveryKeys.draftFile(SITE, slug, "home")}`,
      `put ${deliveryKeys.draftFile(SITE, slug, "y")}`,
      `put ${deliveryKeys.draftFile(SITE, slug, "z")}`,
    ]);
    expect(answer.result?.versions).toMatchObject({
      y: TOMBSTONE_VERSION,
      z: TOMBSTONE_VERSION,
    });
    expect((await readDraftIndex(delivery.store, SITE, slug)).names).toEqual([
      "alone",
      "footer",
      "home",
      "links",
      "y",
      "z",
    ]);
  });

  it("a 412 on the 2nd file answers -32008 with the 1st as landed; the retry of the rest succeeds", async () => {
    const { delivery, slug, call } = setup();
    const second = deliveryKeys.draftFile(SITE, slug, "b");
    let raced = false;
    delivery.hooks.beforePut = (key) => {
      if (key !== second || raced) return;
      raced = true;
      // Another save created b between this save's read and its PUT.
      delivery.objects.set(key, {
        text: JSON.stringify(setFile({ v: "other" }, "usr_bob")),
        etag: '"elsewhere"',
        cacheControl: "",
      });
    };
    const answer = await call("blocks.apply", {
      set: { a: { v: 1 }, b: { v: 1 } },
      ifMatch: { a: null, b: null },
    });
    expect(answer.error?.code).toBe(-32008);
    expect(answer.error?.data).toEqual({
      retryAfterMs: 250,
      landed: { a: blockVersion({ v: 1 }) },
    });
    // The retry of the rest, with its ifMatch unchanged, is refused by the
    // guard (b changed) or lands: here b changed, so it's a Conflict.
    const retry = await call("blocks.apply", {
      set: { b: { v: 1 } },
      ifMatch: { b: null },
    });
    expect(retry.error?.code).toBe(-32002);
    // Without the race, the retry of the rest lands.
    delivery.objects.delete(second);
    const again = await call("blocks.apply", {
      set: { b: { v: 1 } },
      ifMatch: { b: null },
    });
    expect(again.result?.versions).toEqual({ b: blockVersion({ v: 1 }) });
    expect((await readDraftIndex(delivery.store, SITE, slug)).names).toEqual([
      "a",
      "b",
    ]);
  });

  it("a timed-out file PUT is -32008 with what landed; the index already lists it, and the retry of the rest lands", async () => {
    const { delivery, slug, call } = setup();
    const second = deliveryKeys.draftFile(SITE, slug, "b");
    let stalled = false;
    delivery.hooks.beforePut = (key) => {
      if (key !== second || stalled) return;
      stalled = true;
      // What the S3 store throws when R2 doesn't answer in time.
      throw new DeliveryUnavailableError(
        key,
        new Error(`no answer within ${CONDITIONAL_PUT_TIMEOUT_MS} ms`),
      );
    };
    const answer = await call("blocks.apply", {
      set: { a: { v: 1 }, b: { v: 1 } },
      ifMatch: { a: null, b: null },
    });
    expect(answer.error?.code).toBe(-32008);
    expect(answer.error?.data).toEqual({
      retryAfterMs: 250,
      landed: { a: blockVersion({ v: 1 }) },
    });
    // Index first: b is listed though its file isn't written, so readers
    // see it as not in the draft until the retry writes it.
    expect((await readDraftIndex(delivery.store, SITE, slug)).names).toEqual([
      "a",
      "b",
    ]);
    expect(
      (await readDraftFile(delivery.store, SITE, slug, "b")).file,
    ).toBeNull();
    const retry = await call("blocks.apply", {
      set: { b: { v: 1 } },
      ifMatch: { b: null },
    });
    expect(retry.result?.versions).toEqual({ b: blockVersion({ v: 1 }) });
    expect(
      (await readDraftFile(delivery.store, SITE, slug, "b")).file,
    ).not.toBeNull();
  });

  it("a retry whose PUT meets the first try's own late write counts it as landed; another body is still a lost race", async () => {
    for (const late of [{ v: 1 }, { v: 2 }]) {
      const { delivery, slug, call } = setup();
      const second = deliveryKeys.draftFile(SITE, slug, "b");
      let tries = 0;
      delivery.hooks.beforePut = (key) => {
        if (key !== second) return;
        tries++;
        if (tries === 1) {
          throw new DeliveryUnavailableError(
            key,
            new Error(`no answer within ${CONDITIONAL_PUT_TIMEOUT_MS} ms`),
          );
        }
        // The given-up PUT commits now: after the retry read the draft,
        // before the retry's own PUT.
        delivery.objects.set(key, {
          text: JSON.stringify(setFile(late)),
          etag: '"late"',
          cacheControl: "",
        });
      };
      const first = await call("blocks.apply", {
        set: { a: { v: 1 }, b: { v: 1 } },
        ifMatch: { a: null, b: null },
      });
      expect(first.error?.code).toBe(-32008);
      const retry = await call("blocks.apply", {
        set: { b: { v: 1 } },
        ifMatch: { b: null },
      });
      if (late.v === 1) {
        expect(retry.result?.versions).toEqual({ b: blockVersion({ v: 1 }) });
      } else {
        expect(retry.error?.code).toBe(-32008);
        expect(retry.error?.data).toEqual({ retryAfterMs: 250, landed: {} });
      }
    }
  });

  it("an R2 429 before any file landed is -32008 with landed {}", async () => {
    const { delivery, slug, call } = setup();
    delivery.hooks.beforePut = (key) => {
      throw new DeliveryUnavailableError(key, new Error("429 SlowDown"));
    };
    const answer = await call("blocks.apply", {
      set: { a: { t: 1 } },
      ifMatch: { a: null },
    });
    expect(answer.error?.code).toBe(-32008);
    expect(answer.error?.data?.landed).toEqual({});
    delivery.hooks.beforePut = undefined;
    expect(
      (await readDraftFile(delivery.store, SITE, slug, "a")).file,
    ).toBeNull();
  });

  it("a delete writes a delete file and answers the tombstone's version", async () => {
    const { delivery, slug, call } = setup();
    await seedRelease(delivery.store, SITE, R1, { banner: { t: "prod" } });
    const { result } = await call("blocks.apply", {
      delete: ["banner"],
      ifMatch: { banner: null },
    });
    expect(result?.versions).toEqual({ banner: TOMBSTONE_VERSION });
    expect(
      (await readDraftFile(delivery.store, SITE, slug, "banner")).file,
    ).toEqual(deleteFile("usr_ana"));
  });

  it("a save over a published marker is guarded as null and overwrites it with If-Match", async () => {
    const { delivery, slug, call } = setup();
    await seedDraftFile(delivery.store, SITE, slug, "a", {
      operation: "published",
      revision: R1,
      version: null,
    });
    const answer = await call("blocks.apply", {
      set: { a: { v: 3 } },
      ifMatch: { a: null },
    });
    expect(answer.error).toBeUndefined();
  });

  it("the block named index lives at %69ndex.json", async () => {
    const { delivery, slug, call } = setup();
    await call("blocks.apply", {
      set: { index: { v: 1 } },
      ifMatch: { index: null },
    });
    expect(
      delivery.objects.has(`sites/${SITE}/drafts/${slug}/%69ndex.json`),
    ).toBe(true);
    expect((await readDraftIndex(delivery.store, SITE, slug)).names).toEqual([
      "index",
    ]);
    expect((await call("blocks.list")).result?.blocks).toEqual({
      index: { v: 1 },
    });
  });
});

describe("targetsFirst", () => {
  it("orders by refs within the set; ties and cycles in code-unit order", () => {
    const order = targetsFirst(
      new Map<string, Record<string, unknown>>([
        ["c", { x: { __resolveType: "a" } }],
        ["a", { x: { __resolveType: "b" } }],
        ["b", { x: { __resolveType: "a" } }],
        ["d", {}],
      ]),
    );
    expect(order).toEqual(["b", "a", "c", "d"]);
  });
});

describe("changes.* and schema.get", () => {
  it("lists the draft's own names against the live index; discard leaves published markers", async () => {
    const { delivery, slug, call } = setup();
    await seedRelease(delivery.store, SITE, R1, {
      header: { t: "prod" },
      banner: { t: "b" },
    });
    await call("blocks.apply", {
      set: { header: { t: "draft" } },
      delete: ["banner"],
      ifMatch: { header: null, banner: null },
    });
    const list = await call("changes.list");
    expect(list.result?.base).toEqual({ revision: R1, resolvedRef: R1 });
    expect(list.result?.changes).toEqual({
      banner: {
        kind: "delete",
        version: TOMBSTONE_VERSION,
        baseVersion: blockVersion({ t: "b" }),
      },
      header: {
        kind: "set",
        version: blockVersion({ t: "draft" }),
        baseVersion: blockVersion({ t: "prod" }),
      },
    });
    const get = await call("changes.get", { names: ["header"] });
    expect(get.result?.entries).toMatchObject({
      header: { kind: "set", before: { t: "prod" }, after: { t: "draft" } },
    });
    const discard = await call("changes.discard", { names: ["header"] });
    expect(discard.error).toBeUndefined();
    expect(
      (await readDraftFile(delivery.store, SITE, slug, "header")).file,
    ).toEqual({
      operation: "published",
      revision: R1,
      version: blockVersion({ t: "prod" }),
    });
    expect((await readDraftIndex(delivery.store, SITE, slug)).names).toEqual([
      "banner",
    ]);
    expect((await call("changes.list")).result?.changes).toEqual({
      banner: {
        kind: "delete",
        version: TOMBSTONE_VERSION,
        baseVersion: blockVersion({ t: "b" }),
      },
    });
  });

  it("reads schema.json and revalidates the cached copy on every read", async () => {
    const { delivery, call } = setup();
    expect((await call("schema.get")).result?.schema).toBeNull();
    await delivery.store.putText(
      deliveryKeys.schema(SITE),
      '{"root":{}}',
      CACHE_SCHEMA,
    );
    const first = await call("schema.get");
    expect(first.result?.schema).toEqual({ root: {} });
    const second = await call("schema.get");
    expect(second.result?.schema).toEqual({ root: {} });
    expect(delivery.reads.at(-1)).toBe(
      `get ${deliveryKeys.schema(SITE)} if-none-match`,
    );
  });
});
