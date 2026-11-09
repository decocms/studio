/**
 * Publish and rollback on the hosted CMS (design "Publish" steps 1–8;
 * contract §4.5–§4.6), against the in-memory delivery bucket.
 */

import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { indexEntry, META_VERSION } from "./block-meta";
import { blockVersion } from "./block-version";
import { readDraftFile, readDraftIndex } from "./cms-drafts";
import {
  type CmsPublishDeps,
  composeIndex,
  NotPublishedError,
  ProductionMovedError,
  PUBLISH_ATTEMPTS,
  publishCmsDraft,
  RevisionNotFoundError,
  RevisionTooLargeError,
  rollbackToRevision,
} from "./cms-publish";
import {
  clearRevisionCache,
  MalformedObjectError,
  readLatest,
  readLatestObject,
  readRevisionIndex,
  readRevisionMeta,
} from "./cms-release";
import {
  deleteFile,
  seedDraftFile,
  seedRelease,
  setFile,
} from "./cms-test-helpers";
import {
  CACHE_BLOCK,
  CACHE_LATEST,
  DeliveryUnavailableError,
  deliveryKeys,
  newDraftSlug,
} from "./delivery-store";
import { memoryDeliveryStore } from "./hosted-test-helpers";
import { newRevisionId } from "./revision-id";

const SITE = "acme";

beforeEach(() => clearRevisionCache());

let clock = Date.parse("2026-11-04T09:00:00.000Z");

function setup() {
  const delivery = memoryDeliveryStore();
  const slug = newDraftSlug();
  const ids: string[] = [];
  const deps: CmsPublishDeps = {
    store: delivery.store,
    purge: delivery.purge,
    site: SITE,
    previewHosts: ["localhost", "www.acme.com"],
    author: "usr_ana",
    via: "cli",
    now: () => new Date("2026-11-04T10:00:00.000Z"),
    newId: () => {
      const id = newRevisionId(clock++);
      ids.push(id);
      return id;
    },
  };
  const draft = { name: "bf-banner", slug };
  const save = (name: string, data: Record<string, unknown>) =>
    seedDraftFile(delivery.store, SITE, slug, name, setFile(data));
  const remove = (name: string) =>
    seedDraftFile(delivery.store, SITE, slug, name, deleteFile());
  const seed = (blocks: Record<string, unknown>) => {
    const id = newRevisionId(clock++);
    return seedRelease(delivery.store, SITE, id, blocks).then(() => id);
  };
  /** The writes since the last call: puts, refusals and purges. */
  const writes = () => {
    const out = delivery.log.filter((l) => !l.startsWith("delete"));
    delivery.log.length = 0;
    return out;
  };
  return { delivery, deps, draft, save, remove, seed, ids, writes };
}

describe("publishCmsDraft", () => {
  it("a site's first publish: blocks, then the revision, then latest.json (sequence 1), purge, markers, index", async () => {
    const { delivery, deps, draft, save, writes } = setup();
    await save("header", { t: "Olá 😀" });
    writes();
    const result = await publishCmsDraft(deps, draft, "  Black Friday  ");
    expect(result).toMatchObject({
      result: "published",
      previous: null,
      draftEmptied: true,
    });
    const id = (result as { revision: string }).revision;
    const hash = blockVersion({ t: "Olá 😀" });
    expect(writes()).toEqual([
      `put ${deliveryKeys.block(SITE, hash)}`,
      `put ${deliveryKeys.revisionIndex(SITE, id)}`,
      `put ${deliveryKeys.revisionMeta(SITE, id)}`,
      `put ${deliveryKeys.latest(SITE)}`,
      `purge ${deliveryKeys.latest(SITE)}`,
      `put ${deliveryKeys.draftFile(SITE, draft.slug, "header")}`,
      `put ${deliveryKeys.draftIndex(SITE, draft.slug)}`,
    ]);
    const block = delivery.objects.get(deliveryKeys.block(SITE, hash))!;
    expect(block.text).toBe('{"t":"Olá 😀"}');
    expect(block.cacheControl).toBe(CACHE_BLOCK);
    const latest = delivery.objects.get(deliveryKeys.latest(SITE))!;
    expect(latest.cacheControl).toBe(CACHE_LATEST);
    expect(JSON.parse(latest.text)).toEqual({
      revision: id,
      sequence: 1,
      metaVersion: META_VERSION,
      previewHosts: ["localhost", "www.acme.com"],
      blocks: { header: { version: hash } },
    });
    // latest.json's index is byte for byte the revision's.
    const index = delivery.objects.get(
      deliveryKeys.revisionIndex(SITE, id),
    )!.text;
    expect(index).toBe(
      JSON.stringify({
        revision: id,
        sequence: 1,
        metaVersion: META_VERSION,
        blocks: { header: { version: hash } },
      }),
    );
    expect(await readRevisionMeta(delivery.store, SITE, id)).toEqual({
      previous: null,
      draft: "bf-banner",
      author: "usr_ana",
      via: "cli",
      message: "Black Friday",
      publishedAt: "2026-11-04T10:00:00.000Z",
    });
    expect(
      (await readDraftFile(delivery.store, SITE, draft.slug, "header")).file,
    ).toEqual({
      operation: "published",
      revision: id,
      version: hash,
    });
    expect(
      (await readDraftIndex(delivery.store, SITE, draft.slug)).names,
    ).toEqual([]);
  });

  it("the median publish: one block PUT, index, meta, latest, one marker, one index write; no body read", async () => {
    const { delivery, deps, draft, save, seed, writes } = setup();
    const blocks: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) blocks[`b${i}`] = { i };
    blocks.home = {
      __resolveType: "website/pages/Page.tsx",
      path: "/",
      s: [{ __resolveType: "b1" }],
    };
    const r1 = await seed(blocks);
    await save("home", {
      __resolveType: "website/pages/Page.tsx",
      path: "/",
      s: [{ __resolveType: "b2" }],
    });
    writes();
    delivery.reads.length = 0;
    const result = await publishCmsDraft(deps, draft, "");
    expect(result).toMatchObject({
      result: "published",
      previous: r1,
      draftEmptied: true,
    });
    const ops = writes();
    expect(ops.filter((l) => l.includes("/blocks/"))).toHaveLength(1);
    expect(ops.filter((l) => l.startsWith("put"))).toHaveLength(6);
    expect(delivery.reads.filter((r) => r.includes("/blocks/"))).toEqual([]);
    const id = (result as { revision: string }).revision;
    const index = await readRevisionIndex(delivery.store, SITE, id);
    expect(index.sequence).toBe(2);
    // Changed in place; every other entry kept as is.
    expect(Object.keys(index.blocks)).toEqual(Object.keys(blocks));
    expect(index.blocks.home).toEqual({
      version: blockVersion({
        __resolveType: "website/pages/Page.tsx",
        path: "/",
        s: [{ __resolveType: "b2" }],
      }),
      meta: { type: "website/pages/Page.tsx", path: "/", refs: ["b2"] },
    });
    expect(index.blocks.b3).toEqual({ version: blockVersion({ i: 3 }) });
  });

  it("applies sets and deletes over the live index; new names are appended in code-unit order", async () => {
    const { deps, draft, save, remove, seed, delivery } = setup();
    await seed({ a: { v: 1 }, b: { v: 1 }, c: { v: 1 } });
    await save("z", { v: 1 });
    await save("B", { v: 1 });
    await save("b", { v: 2 });
    await remove("a");
    await remove("never-was");
    const result = await publishCmsDraft(deps, draft, "");
    const id = (result as { revision: string }).revision;
    const index = await readRevisionIndex(delivery.store, SITE, id);
    expect(Object.keys(index.blocks)).toEqual(["b", "c", "B", "z"]);
    expect(index.blocks.b?.version).toBe(blockVersion({ v: 2 }));
  });

  it("skips the PUT of a hash the base already names", async () => {
    const { deps, draft, save, seed, writes } = setup();
    await seed({ a: { v: 1 }, b: { v: 2 } });
    // b's new body equals a's: its object exists.
    await save("b", { v: 1 });
    writes();
    await publishCmsDraft(deps, draft, "");
    expect(writes().filter((l) => l.includes("/blocks/"))).toEqual([]);
  });

  it("inlines the CMS settings block's body", async () => {
    const { deps, draft, save, delivery } = setup();
    await save("CMS", { __resolveType: "cms-settings", a: 1 });
    await publishCmsDraft(deps, draft, "");
    const live = await readLatest(delivery.store, SITE);
    expect(live?.latest.blocks.CMS).toEqual(
      await indexEntry("CMS", { __resolveType: "cms-settings", a: 1 }, ["CMS"]),
    );
    expect(live?.latest.blocks.CMS?.data).toEqual({
      __resolveType: "cms-settings",
      a: 1,
    });
  });

  it("is up-to-date when every entry equals production's: no block, revision or latest write, but the draft is emptied", async () => {
    const { deps, draft, save, seed, writes, delivery } = setup();
    const r1 = await seed({ a: { v: 1 } });
    await save("a", { v: 1 });
    writes();
    expect(await publishCmsDraft(deps, draft, "")).toEqual({
      result: "up-to-date",
      revision: r1,
      draftEmptied: true,
    });
    expect(writes()).toEqual([
      `put ${deliveryKeys.draftFile(SITE, draft.slug, "a")}`,
      `put ${deliveryKeys.draftIndex(SITE, draft.slug)}`,
    ]);
    expect(
      (await readDraftFile(delivery.store, SITE, draft.slug, "a")).file,
    ).toEqual({
      operation: "published",
      revision: r1,
      version: blockVersion({ v: 1 }),
    });
  });

  it("an empty draft is up-to-date and writes nothing", async () => {
    const { deps, draft, seed, writes } = setup();
    const r1 = await seed({ a: { v: 1 } });
    writes();
    expect(await publishCmsDraft(deps, draft, "")).toEqual({
      result: "up-to-date",
      revision: r1,
      draftEmptied: false,
    });
    expect(writes()).toEqual([]);
  });

  it("a lost latest.json race restarts from step 1, rereading the draft", async () => {
    const { deps, draft, save, seed, delivery } = setup();
    await seed({ a: { v: 1 } });
    await save("a", { v: 2 });
    let races = 0;
    deps.beforeLatestWrite = async (attempt) => {
      if (attempt !== 1) return;
      races++;
      // Another publish lands; meanwhile someone saves b into the draft.
      await seed({ a: { v: 1 }, other: { v: 1 } });
      await save("b", { v: 1 });
    };
    const result = await publishCmsDraft(deps, draft, "");
    expect(races).toBe(1);
    const id = (result as { revision: string }).revision;
    const index = await readRevisionIndex(delivery.store, SITE, id);
    expect(Object.keys(index.blocks).sort()).toEqual(["a", "b", "other"]);
    expect(index.sequence).toBe(3);
    expect(
      (await readDraftIndex(delivery.store, SITE, draft.slug)).names,
    ).toEqual([]);
  });

  it("answers ProductionMovedError after the third lost race, keeping the draft", async () => {
    const { deps, draft, save, seed, delivery } = setup();
    await seed({ a: { v: 1 } });
    await save("a", { v: 2 });
    let attempts = 0;
    deps.beforeLatestWrite = async () => {
      attempts++;
      await seed({ a: { v: attempts + 10 } });
    };
    await expect(publishCmsDraft(deps, draft, "")).rejects.toBeInstanceOf(
      ProductionMovedError,
    );
    expect(attempts).toBe(PUBLISH_ATTEMPTS);
    expect(
      (await readDraftFile(delivery.store, SITE, draft.slug, "a")).file
        ?.operation,
    ).toBe("set");
    expect(
      (await readDraftIndex(delivery.store, SITE, draft.slug)).names,
    ).toEqual(["a"]);
  });

  it("an autosave during the publish survives: its marker is refused and it stays listed", async () => {
    const { deps, draft, save, seed, delivery } = setup();
    await seed({ a: { v: 1 } });
    await save("a", { v: 2 });
    await save("b", { v: 1 });
    deps.beforeLatestWrite = async () => {
      // After step 2: a is saved again, and c is new.
      await save("a", { v: 3 });
      await save("c", { v: 1 });
    };
    const result = await publishCmsDraft(deps, draft, "");
    expect(result).toMatchObject({ result: "published", draftEmptied: false });
    const id = (result as { revision: string }).revision;
    // The publish holds a's step-2 value.
    expect(
      (await readRevisionIndex(delivery.store, SITE, id)).blocks.a?.version,
    ).toBe(blockVersion({ v: 2 }));
    expect(
      (await readDraftFile(delivery.store, SITE, draft.slug, "a")).file,
    ).toEqual(setFile({ v: 3 }));
    expect(
      (await readDraftFile(delivery.store, SITE, draft.slug, "b")).file
        ?.operation,
    ).toBe("published");
    expect(
      (await readDraftIndex(delivery.store, SITE, draft.slug)).names,
    ).toEqual(["a", "c"]);
  });

  it("a purge failure is only logged: the publish succeeds and the draft is emptied", async () => {
    const { deps, draft, save, delivery } = setup();
    await save("a", { v: 1 });
    delivery.failPurge(true);
    expect(await publishCmsDraft(deps, draft, "")).toMatchObject({
      result: "published",
      draftEmptied: true,
    });
  });

  it("an R2 429 on latest.json is Unavailable, not a lost race (no retry)", async () => {
    const { deps, draft, save, delivery } = setup();
    await save("a", { v: 1 });
    let latestPuts = 0;
    delivery.hooks.beforePut = (key) => {
      if (key !== deliveryKeys.latest(SITE)) return;
      latestPuts++;
      throw new DeliveryUnavailableError(key, new Error("429"));
    };
    await expect(publishCmsDraft(deps, draft, "")).rejects.toBeInstanceOf(
      DeliveryUnavailableError,
    );
    expect(latestPuts).toBe(1);
    expect(
      (await readDraftIndex(delivery.store, SITE, draft.slug)).names,
    ).toEqual(["a"]);
  });

  it("refuses a block over 16 MiB with nothing written", async () => {
    const { deps, draft, save, writes } = setup();
    await save("huge", { s: "x".repeat(16 * 1024 * 1024) });
    writes();
    await expect(publishCmsDraft(deps, draft, "")).rejects.toBeInstanceOf(
      RevisionTooLargeError,
    );
    expect(writes()).toEqual([]);
  });
});

describe("composeIndex", () => {
  it("keeps unchanged entries as they are, even refs to a name since deleted", async () => {
    const base = {
      home: { version: "a".repeat(22), meta: { refs: ["gone"] } },
      gone: { version: "b".repeat(22) },
    };
    const out = await composeIndex(base, new Map(), new Set(["gone"]), {
      readBody: () => Promise.reject(new Error("no body read")),
      baseMetaVersion: META_VERSION,
    });
    expect(out).toEqual({ home: base.home });
  });
});

describe("noIndex and metaVersion", () => {
  const PAGE = "website/pages/Page.tsx";
  const SEO = "website/sections/Seo/SeoV2.tsx";
  const page = (path: string, seo: unknown, sections: unknown[] = []) => ({
    __resolveType: PAGE,
    path,
    seo,
    sections,
  });
  const site = {
    DefaultSeo: { __resolveType: SEO, title: "Acme", noIndexing: false },
    Header: { __resolveType: "site/sections/Header.tsx", logo: "a" },
    home: page("/", { __resolveType: "DefaultSeo" }, [
      { __resolveType: "Header" },
    ]),
    about: page("/about", { __resolveType: SEO, noIndexing: false }, [
      { __resolveType: "Header" },
    ]),
  };
  const bodyReads = (delivery: { reads: string[] }) =>
    delivery.reads.filter((r) => r.includes("/blocks/"));
  const publish = async (ctx: ReturnType<typeof setup>) => {
    const result = await publishCmsDraft(ctx.deps, ctx.draft, "");
    expect(result.result).toBe("published");
    const id = (result as { revision: string }).revision;
    return readRevisionIndex(ctx.delivery.store, SITE, id);
  };

  it("a page's inline seo: noIndex at publish, and metaVersion on index.json and latest.json", async () => {
    const ctx = setup();
    await ctx.save(
      "staging",
      page("/staging", { __resolveType: SEO, noIndexing: true }),
    );
    const index = await publish(ctx);
    expect(index.metaVersion).toBe(META_VERSION);
    expect(index.blocks.staging?.meta).toEqual({
      type: PAGE,
      path: "/staging",
      noIndex: true,
    });
    const latest = JSON.parse(
      ctx.delivery.objects.get(deliveryKeys.latest(SITE))!.text,
    );
    expect(latest.metaVersion).toBe(META_VERSION);
    expect(latest.blocks.staging.meta.noIndex).toBe(true);
  });

  it("a new page whose seo is the saved DefaultSeo: that block is read and followed", async () => {
    const ctx = setup();
    await ctx.seed({
      ...site,
      DefaultSeo: { ...site.DefaultSeo, noIndexing: true },
    });
    await ctx.save(
      "landing",
      page("/landing", { __resolveType: "DefaultSeo" }),
    );
    ctx.delivery.reads.length = 0;
    const index = await publish(ctx);
    expect(index.blocks.landing?.meta).toEqual({
      type: PAGE,
      path: "/landing",
      refs: ["DefaultSeo"],
      noIndex: true,
    });
    expect(bodyReads(ctx.delivery)).toHaveLength(1);
  });

  it("DefaultSeo turned noIndexing: every page whose seo it is is recomputed, the others kept", async () => {
    const ctx = setup();
    const seeded = await seedRelease(
      ctx.delivery.store,
      SITE,
      newRevisionId(clock++),
      site,
    );
    expect(seeded.home?.meta?.noIndex).toBeUndefined();
    await ctx.save("DefaultSeo", { ...site.DefaultSeo, noIndexing: true });
    const index = await publish(ctx);
    expect(index.blocks.home).toEqual({
      version: seeded.home!.version,
      meta: {
        type: PAGE,
        path: "/",
        refs: ["DefaultSeo", "Header"],
        noIndex: true,
      },
    });
    expect(index.blocks.about).toEqual(seeded.about!);
    expect(index.blocks.Header).toEqual(seeded.Header!);

    // And back: deleting it clears home's noIndex.
    await ctx.remove("DefaultSeo");
    const after = await publish(ctx);
    expect(after.blocks.home?.meta?.noIndex).toBeUndefined();
    expect(after.blocks.home?.version).toBe(seeded.home!.version);
    expect(after.blocks.DefaultSeo).toBeUndefined();
  });

  it("an edit whose seo answer doesn't change (Header) reads no page body", async () => {
    const ctx = setup();
    const seeded = await seedRelease(
      ctx.delivery.store,
      SITE,
      newRevisionId(clock++),
      site,
    );
    await ctx.save("Header", { ...site.Header, logo: "b" });
    await ctx.save("DefaultSeo", { ...site.DefaultSeo, title: "Acme!" });
    ctx.delivery.reads.length = 0;
    const index = await publish(ctx);
    // Only the old DefaultSeo and Header, to compare their answers.
    expect(bodyReads(ctx.delivery).sort()).toEqual(
      [
        `get ${deliveryKeys.block(SITE, seeded.DefaultSeo!.version)}`,
        `get ${deliveryKeys.block(SITE, seeded.Header!.version)}`,
      ].sort(),
    );
    expect(index.blocks.home).toEqual(seeded.home!);
  });

  it("the backfill: a publish onto an index without metaVersion recomputes every entry", async () => {
    const ctx = setup();
    const legacy = await seedRelease(
      ctx.delivery.store,
      SITE,
      newRevisionId(clock++),
      {
        ...site,
        DefaultSeo: { ...site.DefaultSeo, noIndexing: true },
        staging: page("/staging", { __resolveType: SEO, noIndexing: true }),
        CMS: { __resolveType: "cms-settings", a: 1 },
      },
      {},
      { legacy: true },
    );
    const live = await readLatest(ctx.delivery.store, SITE);
    expect(live?.latest.metaVersion).toBeUndefined();
    expect(legacy.home?.meta?.noIndex).toBeUndefined();
    expect(legacy.staging?.meta?.noIndex).toBeUndefined();
    // A draft that touches neither page.
    await ctx.save("Header", { ...site.Header, logo: "b" });
    const index = await publish(ctx);
    expect(index.metaVersion).toBe(META_VERSION);
    expect(index.blocks.home?.meta?.noIndex).toBe(true);
    expect(index.blocks.staging?.meta?.noIndex).toBe(true);
    expect(index.blocks.about?.meta).toEqual(legacy.about!.meta!);
    expect(index.blocks.home?.version).toBe(legacy.home!.version);
    expect(index.blocks.CMS).toEqual(legacy.CMS!);
  });

  it("a draft equal to a legacy index still publishes, to write metaVersion", async () => {
    const ctx = setup();
    await seedRelease(
      ctx.delivery.store,
      SITE,
      newRevisionId(clock++),
      { a: { v: 1 } },
      {},
      { legacy: true },
    );
    await ctx.save("a", { v: 1 });
    const index = await publish(ctx);
    expect(index.metaVersion).toBe(META_VERSION);
    expect(index.blocks).toEqual({ a: { version: blockVersion({ v: 1 }) } });
  });

  it("a rollback to a legacy revision recomputes its entries and writes metaVersion", async () => {
    const ctx = setup();
    const r1 = newRevisionId(clock++);
    await seedRelease(
      ctx.delivery.store,
      SITE,
      r1,
      {
        ...site,
        DefaultSeo: { ...site.DefaultSeo, noIndexing: true },
      },
      {},
      { legacy: true },
    );
    await ctx.seed({ a: { v: 2 } });
    const result = await rollbackToRevision(ctx.deps, r1, "");
    expect(result.result).toBe("published");
    const id = (result as { revision: string }).revision;
    const index = await readRevisionIndex(ctx.delivery.store, SITE, id);
    expect(index.metaVersion).toBe(META_VERSION);
    expect(index.blocks.home?.meta?.noIndex).toBe(true);
  });

  it("reading an index keeps noIndex and metaVersion; a legacy one has neither", async () => {
    const ctx = setup();
    const id = newRevisionId(clock++);
    await seedRelease(ctx.delivery.store, SITE, id, {
      staging: page("/s", { noIndexing: true }),
    });
    clearRevisionCache();
    const index = await readRevisionIndex(ctx.delivery.store, SITE, id);
    expect(index.metaVersion).toBe(META_VERSION);
    expect(index.blocks.staging?.meta?.noIndex).toBe(true);
    const old = newRevisionId(clock++);
    await seedRelease(
      ctx.delivery.store,
      SITE,
      old,
      { staging: page("/s", { noIndexing: true }) },
      {},
      { legacy: true },
    );
    clearRevisionCache();
    const legacy = await readRevisionIndex(ctx.delivery.store, SITE, old);
    expect(legacy).not.toHaveProperty("metaVersion");
    expect(legacy.blocks.staging?.meta).not.toHaveProperty("noIndex");
  });
});

describe("rollbackToRevision", () => {
  async function history() {
    const ctx = setup();
    const r1 = newRevisionId(clock++);
    const r2 = newRevisionId(clock++);
    await seedRelease(
      ctx.delivery.store,
      SITE,
      r1,
      { a: { v: 1 } },
      { message: "Summer sale" },
    );
    await seedRelease(ctx.delivery.store, SITE, r2, { a: { v: 2 }, added: {} });
    return { ...ctx, r1, r2 };
  }

  it("copies the target's index with the next sequence, writing no block object", async () => {
    const { delivery, deps, r1, r2, writes } = await history();
    writes();
    const result = await rollbackToRevision(deps, r1, "");
    expect(result).toMatchObject({ result: "published", previous: r2 });
    const id = (result as { revision: string }).revision;
    const ops = writes();
    expect(ops.filter((l) => l.includes("/blocks/"))).toEqual([]);
    expect(ops).toEqual([
      `put ${deliveryKeys.revisionIndex(SITE, id)}`,
      `put ${deliveryKeys.revisionMeta(SITE, id)}`,
      `put ${deliveryKeys.latest(SITE)}`,
      `purge ${deliveryKeys.latest(SITE)}`,
    ]);
    const index = await readRevisionIndex(delivery.store, SITE, id);
    expect(index.sequence).toBe(3);
    expect(index.blocks).toEqual({ a: { version: blockVersion({ v: 1 }) } });
    const meta = await readRevisionMeta(delivery.store, SITE, id);
    expect(meta).toEqual({
      reapplyOf: r1,
      previous: r2,
      author: "usr_ana",
      via: "cli",
      message: "Made current: Summer sale",
      publishedAt: "2026-11-04T10:00:00.000Z",
    });
  });

  it("is a no-op when the target equals the live index", async () => {
    const { deps, r2, writes } = await history();
    writes();
    expect(await rollbackToRevision(deps, r2, "")).toEqual({
      result: "up-to-date",
      revision: r2,
    });
    expect(writes()).toEqual([]);
  });

  it("refuses a target with no meta.json, and one whose index.json is missing", async () => {
    const { delivery, deps, r1 } = await history();
    await expect(
      rollbackToRevision(deps, newRevisionId(clock++), ""),
    ).rejects.toBeInstanceOf(RevisionNotFoundError);
    delivery.objects.delete(deliveryKeys.revisionIndex(SITE, r1));
    await expect(rollbackToRevision(deps, r1, "")).rejects.toBeInstanceOf(
      MalformedObjectError,
    );
  });

  it("refuses a rollback before the first latest.json, writing nothing", async () => {
    const { delivery, deps, writes } = setup();
    const crashed = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, crashed, { a: { v: 1 } });
    delivery.objects.delete(deliveryKeys.latest(SITE));
    clearRevisionCache();
    writes();
    await expect(rollbackToRevision(deps, crashed, "")).rejects.toBeInstanceOf(
      NotPublishedError,
    );
    expect(writes()).toEqual([]);
    expect(await readLatest(delivery.store, SITE)).toBeNull();
  });

  it("answers ProductionMovedError after 3 lost races", async () => {
    const { deps, r1, delivery } = await history();
    let n = 0;
    deps.beforeLatestWrite = async () => {
      n++;
      await seedRelease(delivery.store, SITE, newRevisionId(clock++), {
        a: { v: 100 + n },
      });
    };
    await expect(rollbackToRevision(deps, r1, "")).rejects.toBeInstanceOf(
      ProductionMovedError,
    );
    expect(n).toBe(3);
  });
});

describe("readRevisionMeta", () => {
  it("caches a parsed meta.json by (site, id), never an absent one", async () => {
    const { delivery } = setup();
    const id = newRevisionId(clock++);
    const metaReads = () =>
      delivery.reads.filter(
        (r) => r === `get ${deliveryKeys.revisionMeta(SITE, id)}`,
      ).length;
    expect(await readRevisionMeta(delivery.store, SITE, id)).toBeNull();
    expect(await readRevisionMeta(delivery.store, SITE, id)).toBeNull();
    expect(metaReads()).toBe(2);
    await seedRelease(delivery.store, SITE, id, { a: {} });
    const first = await readRevisionMeta(delivery.store, SITE, id);
    const second = await readRevisionMeta(delivery.store, SITE, id);
    expect(second).toEqual(first);
    expect(first?.author).toBe("usr_seed");
    expect(metaReads()).toBe(3);
  });

  it("never caches a parse failure: a fixed meta.json is seen on the next read", async () => {
    const { delivery } = setup();
    const id = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, id, { a: {} });
    clearRevisionCache();
    const key = deliveryKeys.revisionMeta(SITE, id);
    const good = delivery.objects.get(key)!;
    delivery.objects.set(key, { text: "{nope", etag: '"x"', cacheControl: "" });
    await expect(
      readRevisionMeta(delivery.store, SITE, id),
    ).rejects.toBeInstanceOf(MalformedObjectError);
    delivery.objects.set(key, good);
    expect((await readRevisionMeta(delivery.store, SITE, id))?.author).toBe(
      "usr_seed",
    );
  });
});

describe("readLatest", () => {
  it("revalidates the cached copy with If-None-Match on every read", async () => {
    const { delivery, seed } = setup();
    const r1 = await seed({ a: { v: 1 } });
    delivery.reads.length = 0;
    expect((await readLatest(delivery.store, SITE))?.latest.revision).toBe(r1);
    expect((await readLatest(delivery.store, SITE))?.latest.revision).toBe(r1);
    expect(delivery.reads).toEqual([
      `get ${deliveryKeys.latest(SITE)} if-none-match`,
      `get ${deliveryKeys.latest(SITE)} if-none-match`,
    ]);
  });
});

/** A latest.json from before content-addressed revisions: a 40-hex SHA. */
const PRE_163_LATEST = JSON.stringify({
  revision: "0123456789abcdef0123456789abcdef01234567",
  sequence: 4,
  blocks: { a: "revisions/0123456789abcdef0123456789abcdef01234567.json" },
});

describe("a malformed latest.json reads as no release yet", () => {
  function malformed(delivery: ReturnType<typeof setup>["delivery"]) {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    delivery.objects.set(`sites/${SITE}/revisions/${sha}.json`, {
      text: '{"a":{}}',
      etag: '"sha"',
      cacheControl: "",
    });
    delivery.objects.set(deliveryKeys.latest(SITE), {
      text: PRE_163_LATEST,
      etag: '"old"',
      cacheControl: "",
    });
  }

  it.each([
    [
      "a pre-content-addressed pointer",
      PRE_163_LATEST,
      "revision is not an id",
    ],
    ["unparseable JSON", "{not json", "not JSON"],
    [
      "a bad entry",
      JSON.stringify({
        revision: newRevisionId(clock),
        sequence: 1,
        blocks: { a: { version: "short" } },
      }),
      'entry "a" is malformed',
    ],
  ])("%s: null, one warning per read, never cached", async (_, text, why) => {
    const { delivery } = setup();
    delivery.objects.set(deliveryKeys.latest(SITE), {
      text,
      etag: '"old"',
      cacheControl: "",
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await readLatest(delivery.store, SITE)).toBeNull();
      expect(await readLatestObject(delivery.store, SITE)).toEqual({
        release: null,
        etag: '"old"',
      });
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "cms: latest.json is malformed; read as no release yet",
        { site: SITE, key: deliveryKeys.latest(SITE), why },
      );
    } finally {
      warn.mockRestore();
    }
    // Nothing cached: neither read was conditional.
    expect(delivery.reads).toEqual([
      `get ${deliveryKeys.latest(SITE)}`,
      `get ${deliveryKeys.latest(SITE)}`,
    ]);
  });

  it("a publish replaces it If-Match its ETag, as a first publish (sequence 1)", async () => {
    const { delivery, deps, draft, save, writes } = setup();
    malformed(delivery);
    await save("a", { v: 1 });
    writes();
    const conditions: unknown[] = [];
    delivery.hooks.beforePut = (key, condition) => {
      if (key === deliveryKeys.latest(SITE)) conditions.push(condition);
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const result = await publishCmsDraft(deps, draft, "");
    warn.mockRestore();
    expect(result).toMatchObject({ result: "published", previous: null });
    const id = (result as { revision: string }).revision;
    expect(conditions).toEqual([{ ifMatch: '"old"' }]);
    expect(writes()).toContain(`put ${deliveryKeys.latest(SITE)}`);
    const live = await readLatest(delivery.store, SITE);
    expect(live?.latest).toMatchObject({ revision: id, sequence: 1 });
    expect(await readRevisionMeta(delivery.store, SITE, id)).toMatchObject({
      previous: null,
    });
  });

  it("a concurrent publish over it is still a lost race: the retry builds on it", async () => {
    const { delivery, deps, draft, save, writes } = setup();
    malformed(delivery);
    await save("b", { v: 2 });
    const other = newRevisionId(clock++);
    deps.beforeLatestWrite = async (attempt) => {
      if (attempt === 1)
        await seedRelease(delivery.store, SITE, other, { a: { v: 1 } });
    };
    writes();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const result = await publishCmsDraft(deps, draft, "");
    warn.mockRestore();
    expect(writes()).toContain(`refused ${deliveryKeys.latest(SITE)}`);
    expect(result).toMatchObject({ result: "published", previous: other });
    const live = await readLatest(delivery.store, SITE);
    expect(live?.latest.sequence).toBe(2);
    expect(Object.keys(live?.latest.blocks ?? {})).toEqual(["a", "b"]);
  });

  it("a rollback over it is refused as before the first publish, writing nothing", async () => {
    const { delivery, deps, writes } = setup();
    const target = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, target, { a: { v: 1 } });
    delivery.objects.set(deliveryKeys.latest(SITE), {
      text: "{not json",
      etag: '"old"',
      cacheControl: "",
    });
    writes();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    await expect(rollbackToRevision(deps, target, "")).rejects.toBeInstanceOf(
      NotPublishedError,
    );
    warn.mockRestore();
    expect(writes()).toEqual([]);
  });

  it("a malformed index a valid latest.json's release names still fails", async () => {
    const { delivery, deps, seed } = setup();
    const r1 = await seed({ a: { v: 1 } });
    await seed({ a: { v: 2 } });
    delivery.objects.set(deliveryKeys.revisionIndex(SITE, r1), {
      text: "{not json",
      etag: '"x"',
      cacheControl: "",
    });
    await expect(
      readRevisionIndex(delivery.store, SITE, r1),
    ).rejects.toBeInstanceOf(MalformedObjectError);
    await expect(rollbackToRevision(deps, r1, "")).rejects.toBeInstanceOf(
      MalformedObjectError,
    );
  });

  it("a cached release replaced by a malformed latest.json reads as none, uncached", async () => {
    const { delivery, seed } = setup();
    await seed({ a: { v: 1 } });
    expect(await readLatest(delivery.store, SITE)).not.toBeNull();
    delivery.objects.set(deliveryKeys.latest(SITE), {
      text: PRE_163_LATEST,
      etag: '"old"',
      cacheControl: "",
    });
    delivery.reads.length = 0;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await readLatest(delivery.store, SITE)).toBeNull();
      expect(await readLatest(delivery.store, SITE)).toBeNull();
    } finally {
      warn.mockRestore();
    }
    // The first read revalidated the valid copy; it dropped it, so the
    // second read is whole.
    expect(delivery.reads).toEqual([
      `get ${deliveryKeys.latest(SITE)} if-none-match`,
      `get ${deliveryKeys.latest(SITE)}`,
    ]);
  });

  it("a malformed latest.json changed or deleted mid-publish is a lost race", async () => {
    for (const change of ["rewritten", "deleted"] as const) {
      const { delivery, deps, draft, save } = setup();
      malformed(delivery);
      await save("a", { v: 1 });
      const conditions: unknown[] = [];
      delivery.hooks.beforePut = (key, condition) => {
        if (key === deliveryKeys.latest(SITE)) conditions.push(condition);
      };
      deps.beforeLatestWrite = async (attempt) => {
        if (attempt !== 1) return;
        if (change === "deleted") {
          delivery.objects.delete(deliveryKeys.latest(SITE));
        } else {
          delivery.objects.set(deliveryKeys.latest(SITE), {
            text: "{still not json",
            etag: '"new"',
            cacheControl: "",
          });
        }
      };
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      const result = await publishCmsDraft(deps, draft, "");
      warn.mockRestore();
      expect(result).toMatchObject({ result: "published", previous: null });
      expect(conditions).toEqual([
        { ifMatch: '"old"' },
        change === "deleted" ? { ifNoneMatch: "*" } : { ifMatch: '"new"' },
      ]);
      const live = await readLatest(delivery.store, SITE);
      expect(live?.latest).toMatchObject({
        revision: (result as { revision: string }).revision,
        sequence: 1,
      });
    }
  });
});
