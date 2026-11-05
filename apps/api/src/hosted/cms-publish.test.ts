/**
 * Publish and rollback on the hosted CMS (design steps 1–6; contract §4.9,
 * §4.11), against the in-memory delivery bucket.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { readDraftObject, writeDraftObject } from "./cms-drafts";
import {
  PUBLISH_ATTEMPTS,
  ProductionMovedError,
  publishCmsDraft,
  RevisionNotFoundError,
  rollbackToRevision,
  type CmsPublishDeps,
} from "./cms-publish";
import {
  clearRevisionCache,
  MalformedObjectError,
  readLatestPointer,
  readRevision,
  readRevisionMeta,
  serializeRevisionData,
} from "./cms-release";
import { seedRelease } from "./cms-test-helpers";
import {
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
  const saveDraft = (set: Record<string, unknown>, del: string[] = []) =>
    readDraftObject(delivery.store, SITE, slug).then((read) =>
      writeDraftObject(
        delivery.store,
        SITE,
        slug,
        { set, delete: del, editors: {} },
        read.etag,
      ),
    );
  return { delivery, deps, draft, saveDraft, ids };
}

describe("publishCmsDraft", () => {
  it("a site's first publish creates latest.json create-only, revision first", async () => {
    const { delivery, deps, draft, saveDraft } = setup();
    await saveDraft({ header: { t: "Olá 😀" } });
    const result = await publishCmsDraft(deps, draft, "  Black Friday  ");
    expect(result).toMatchObject({
      result: "published",
      previous: null,
      draftEmptied: true,
    });
    const id = (result as { revision: string }).revision;
    const order = delivery.log.filter(
      (l) => l.startsWith("put") || l.startsWith("purge"),
    );
    expect(order.slice(-5)).toEqual([
      `put ${deliveryKeys.revisionData(SITE, id)}`,
      `put ${deliveryKeys.revisionMeta(SITE, id)}`,
      `put ${deliveryKeys.latest(SITE)}`,
      `purge ${deliveryKeys.latest(SITE)}`,
      `put ${deliveryKeys.draft(SITE, draft.slug)}`,
    ]);
    // latest.json: {revision, previewHosts} only, today's cache header.
    const latest = delivery.objects.get(deliveryKeys.latest(SITE));
    expect(JSON.parse(latest!.text)).toEqual({
      revision: id,
      previewHosts: ["localhost", "www.acme.com"],
    });
    expect(latest!.cacheControl).toBe(CACHE_LATEST);
    // data.json: {blocks} alone, escaped to ASCII.
    const data = delivery.objects.get(
      deliveryKeys.revisionData(SITE, id),
    )!.text;
    expect(data).toBe('{"blocks":{"header":{"t":"Ol\\u00e1 \\ud83d\\ude00"}}}');
    expect(JSON.parse(data)).toEqual({ blocks: { header: { t: "Olá 😀" } } });
    expect(await readRevisionMeta(delivery.store, SITE, id)).toEqual({
      previous: null,
      draft: "bf-banner",
      author: "usr_ana",
      via: "cli",
      message: "Black Friday",
      publishedAt: "2026-11-04T10:00:00.000Z",
    });
    expect(
      (await readDraftObject(delivery.store, SITE, draft.slug)).body,
    ).toEqual({
      set: {},
      delete: [],
      editors: {},
    });
  });

  it("applies the draft over the latest release, recording it as previous", async () => {
    const { delivery, deps, draft, saveDraft } = setup();
    const r1 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r1, {
      header: { t: 1 },
      footer: { t: 1 },
      gone: {},
    });
    await saveDraft({ header: { t: 2 } }, ["gone", "never-existed"]);
    const result = await publishCmsDraft(deps, draft, "");
    expect(result).toMatchObject({ result: "published", previous: r1 });
    const id = (result as { revision: string }).revision;
    expect((await readRevision(delivery.store, SITE, id)).blocks).toEqual({
      footer: { t: 1 },
      header: { t: 2 },
    });
    expect((await readRevisionMeta(delivery.store, SITE, id))?.previous).toBe(
      r1,
    );
  });

  it("is a no-op that writes nothing when every draft block equals production's", async () => {
    const { delivery, deps, draft, saveDraft } = setup();
    const r1 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r1, { header: { b: 1, a: 2 } });
    await saveDraft({ header: { a: 2, b: 1 } }, ["absent"]);
    const before = delivery.log.length;
    const result = await publishCmsDraft(deps, draft, "");
    expect(result).toEqual({
      result: "up-to-date",
      revision: r1,
      draftEmptied: true,
    });
    // Only the draft is emptied (step 6).
    expect(delivery.log.slice(before)).toEqual([
      `put ${deliveryKeys.draft(SITE, draft.slug)}`,
    ]);
  });

  it("an already-empty draft is not rewritten", async () => {
    const { delivery, deps, draft, saveDraft } = setup();
    await saveDraft({});
    const before = delivery.log.length;
    expect(await publishCmsDraft(deps, draft, "")).toEqual({
      result: "up-to-date",
      revision: null,
      draftEmptied: false,
    });
    expect(delivery.log.length).toBe(before);
  });

  it("retries a lost latest.json race with the same draft read, 3 attempts in total", async () => {
    const { delivery, deps, draft, saveDraft, ids } = setup();
    const r1 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r1, { header: { t: 1 } });
    await saveDraft({ header: { t: 2 } });
    let draftReads = 0;
    const get = delivery.store.get;
    delivery.store.get = async (key) => {
      if (key === deliveryKeys.draft(SITE, draft.slug)) draftReads++;
      return get(key);
    };
    let other: string | null = null;
    deps.beforeLatestWrite = async (attempt) => {
      if (attempt !== 1) return;
      // Someone published first.
      other = newRevisionId(clock++);
      await seedRelease(delivery.store, SITE, other, {
        header: { t: 1 },
        theirs: { t: 9 },
      });
    };
    const result = await publishCmsDraft(deps, draft, "");
    expect(result).toMatchObject({ result: "published", previous: other });
    expect(ids.length).toBe(2);
    expect(draftReads).toBe(1);
    const id = (result as { revision: string }).revision;
    expect((await readRevision(delivery.store, SITE, id)).blocks).toEqual({
      header: { t: 2 },
      theirs: { t: 9 },
    });
    // The first attempt's revision stays: latest.json never names it.
    expect(
      await readRevisionMeta(delivery.store, SITE, ids[0]!),
    ).not.toBeNull();
    expect(
      (await readLatestPointer(delivery.store, SITE))?.pointer.revision,
    ).toBe(id);
  });

  it("answers ProductionMovedError after the third lost race, keeping the draft", async () => {
    const { delivery, deps, draft, saveDraft } = setup();
    await seedRelease(delivery.store, SITE, newRevisionId(clock++), { a: {} });
    await saveDraft({ a: { t: 1 } });
    let races = 0;
    deps.beforeLatestWrite = async () => {
      races++;
      await seedRelease(delivery.store, SITE, newRevisionId(clock++), {
        a: {},
        n: races,
      });
    };
    await expect(publishCmsDraft(deps, draft, "")).rejects.toBeInstanceOf(
      ProductionMovedError,
    );
    expect(races).toBe(PUBLISH_ATTEMPTS);
    expect(
      (await readDraftObject(delivery.store, SITE, draft.slug)).body.set,
    ).toEqual({
      a: { t: 1 },
    });
  });

  it("a purge failure is only logged: the publish succeeds and the draft is emptied", async () => {
    const { delivery, deps, draft, saveDraft } = setup();
    await saveDraft({ a: { t: 1 } });
    delivery.failPurge(true);
    const result = await publishCmsDraft(deps, draft, "");
    expect(result).toMatchObject({ result: "published", draftEmptied: true });
  });

  it("a save made during the publish keeps the draft (empty with If-Match: D)", async () => {
    const { delivery, deps, draft, saveDraft } = setup();
    await saveDraft({ a: { t: 1 } });
    deps.beforeLatestWrite = async () => {
      await saveDraft({ a: { t: 1 }, b: { t: "meanwhile" } });
    };
    const result = await publishCmsDraft(deps, draft, "");
    expect(result).toMatchObject({ result: "published", draftEmptied: false });
    expect(
      (await readDraftObject(delivery.store, SITE, draft.slug)).body.set,
    ).toEqual({
      a: { t: 1 },
      b: { t: "meanwhile" },
    });
  });

  it("an R2 429 on latest.json is Unavailable, not a lost race (no retry)", async () => {
    const { delivery, deps, draft, saveDraft, ids } = setup();
    await saveDraft({ a: { t: 1 } });
    delivery.hooks.beforePut = (key) => {
      if (key === deliveryKeys.latest(SITE)) {
        throw new DeliveryUnavailableError(key, new Error("429"));
      }
    };
    await expect(publishCmsDraft(deps, draft, "")).rejects.toBeInstanceOf(
      DeliveryUnavailableError,
    );
    expect(ids.length).toBe(1);
    delivery.hooks.beforePut = undefined;
    // A crash before latest.json leaves a revision that never went live.
    expect(await readLatestPointer(delivery.store, SITE)).toBeNull();
    expect(
      await readRevisionMeta(delivery.store, SITE, ids[0]!),
    ).not.toBeNull();
  });
});

describe("rollbackToRevision: unreadable objects", () => {
  it("the target's meta.json unparseable is malformed; one on its history doesn't matter", async () => {
    const ctx = setup();
    const r1 = newRevisionId(clock++);
    const r2 = newRevisionId(clock++);
    const r3 = newRevisionId(clock++);
    await seedRelease(ctx.delivery.store, SITE, r1, { a: { v: 1 } });
    await seedRelease(ctx.delivery.store, SITE, r2, { a: { v: 2 } });
    await seedRelease(ctx.delivery.store, SITE, r3, { a: { v: 3 } });
    const unparseable = { text: "{nope", etag: '"x"', cacheControl: "" };
    ctx.delivery.objects.set(deliveryKeys.revisionMeta(SITE, r2), unparseable);
    await expect(rollbackToRevision(ctx.deps, r2, "")).rejects.toBeInstanceOf(
      MalformedObjectError,
    );
    // No walk of previous: r1 is reapplied past r2's broken meta.json.
    expect(await rollbackToRevision(ctx.deps, r1, "")).toMatchObject({
      result: "published",
      previous: r3,
    });
  });

  it("the target's data.json missing is malformed", async () => {
    const ctx = setup();
    const r1 = newRevisionId(clock++);
    const r2 = newRevisionId(clock++);
    await seedRelease(ctx.delivery.store, SITE, r1, { a: { v: 1 } });
    await seedRelease(ctx.delivery.store, SITE, r2, { a: { v: 2 } });
    ctx.delivery.objects.delete(deliveryKeys.revisionData(SITE, r1));
    await expect(rollbackToRevision(ctx.deps, r1, "")).rejects.toBeInstanceOf(
      MalformedObjectError,
    );
  });
});

describe("readRevisionMeta", () => {
  it("caches a parsed meta.json by (site, id), never an absent one", async () => {
    const { delivery } = setup();
    const id = newRevisionId(clock++);
    let gets = 0;
    const get = delivery.store.get.bind(delivery.store);
    delivery.store.get = (async (key: string, options?: unknown) => {
      gets++;
      return (get as (k: string, o?: unknown) => ReturnType<typeof get>)(
        key,
        options,
      );
    }) as typeof delivery.store.get;
    expect(await readRevisionMeta(delivery.store, SITE, id)).toBeNull();
    expect(await readRevisionMeta(delivery.store, SITE, id)).toBeNull();
    expect(gets).toBe(2);
    await seedRelease(delivery.store, SITE, id, { a: {} });
    gets = 0;
    const first = await readRevisionMeta(delivery.store, SITE, id);
    const second = await readRevisionMeta(delivery.store, SITE, id);
    expect(second).toEqual(first);
    expect(first?.author).toBe("usr_seed");
    expect(gets).toBe(1);
  });

  it("never caches a read or parse failure: a fixed meta.json is seen on the next read", async () => {
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
    const get = delivery.store.get.bind(delivery.store);
    let failing = true;
    delivery.store.get = (async (k: string) => {
      if (failing) throw new DeliveryUnavailableError(k, new Error("503"));
      return get(k);
    }) as typeof delivery.store.get;
    await expect(
      readRevisionMeta(delivery.store, SITE, id),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
    failing = false;
    delivery.objects.set(key, good);
    expect((await readRevisionMeta(delivery.store, SITE, id))?.author).toBe(
      "usr_seed",
    );
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

  it("publishes a copy of the target with reapplyOf and no draft", async () => {
    const { delivery, deps, r1, r2 } = await history();
    const result = await rollbackToRevision(deps, r1, "");
    expect(result).toMatchObject({ result: "published", previous: r2 });
    const id = (result as { revision: string }).revision;
    // Blocks added since are dropped.
    expect((await readRevision(delivery.store, SITE, id)).blocks).toEqual({
      a: { v: 1 },
    });
    const meta = await readRevisionMeta(delivery.store, SITE, id);
    expect(meta).toEqual({
      reapplyOf: r1,
      previous: r2,
      author: "usr_ana",
      via: "cli",
      message: "Made current: Summer sale",
      publishedAt: "2026-11-04T10:00:00.000Z",
    });
    expect(meta && "draft" in meta).toBe(false);
  });

  it("is a no-op when the target equals the live blocks", async () => {
    const { delivery, deps, r2 } = await history();
    const before = delivery.log.length;
    expect(await rollbackToRevision(deps, r2, "")).toEqual({
      result: "up-to-date",
      revision: r2,
    });
    expect(delivery.log.length).toBe(before);
  });

  it("reapplies a revision latest.json never named (a lost race); refuses one with no meta", async () => {
    const { delivery, deps, r2 } = await history();
    const orphan = newRevisionId(clock++);
    await delivery.store.putText(
      deliveryKeys.revisionData(SITE, orphan),
      serializeRevisionData({ x: {} }),
      "",
    );
    await expect(rollbackToRevision(deps, orphan, "")).rejects.toBeInstanceOf(
      RevisionNotFoundError,
    );
    await expect(
      rollbackToRevision(deps, newRevisionId(clock++), ""),
    ).rejects.toBeInstanceOf(RevisionNotFoundError);
    await delivery.store.putJson(
      deliveryKeys.revisionMeta(SITE, orphan),
      {
        previous: r2,
        author: "u",
        via: "studio",
        message: "Lost the race",
        publishedAt: "2026-11-04T00:00:00.000Z",
      },
      "",
    );
    const result = await rollbackToRevision(deps, orphan, "");
    expect(result).toMatchObject({ result: "published", previous: r2 });
    const id = (result as { revision: string }).revision;
    expect((await readRevision(delivery.store, SITE, id)).blocks).toEqual({
      x: {},
    });
    expect(await readRevisionMeta(delivery.store, SITE, id)).toMatchObject({
      reapplyOf: orphan,
      message: "Made current: Lost the race",
    });
  });

  it("reapplies a revision before the first latest.json, as publish does", async () => {
    const { delivery, deps } = setup();
    const crashed = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, crashed, { a: { v: 1 } });
    delivery.objects.delete(deliveryKeys.latest(SITE));
    const result = await rollbackToRevision(deps, crashed, "");
    expect(result).toMatchObject({ result: "published", previous: null });
    expect(
      (await readLatestPointer(delivery.store, SITE))?.pointer.revision,
    ).toBe((result as { revision: string }).revision);
  });
});
