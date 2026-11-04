/**
 * The hosted CMS's content-protocol storage, through the protocol's real
 * handler: the latest release with the draft layered on, saves against the
 * draft only, conflicts from the save's own read, no retries.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { TOMBSTONE_VERSION } from "@decocms/blocks/protocol";
import { createContentHandler } from "@decocms/blocks/protocol/server";
import { blockVersion } from "./block-version";
import { readDraftObject, writeDraftObject } from "./cms-drafts";
import { clearRevisionCache } from "./cms-release";
import {
  clearSchemaCache,
  createCmsStorage,
  withConflictBlocks,
} from "./cms-storage";
import { memoryRecordStore, seedRelease } from "./cms-test-helpers";
import {
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

function setup(userId = "usr_ana", now = 1793800000) {
  const delivery = memoryDeliveryStore();
  const records = memoryRecordStore();
  const slug = newDraftSlug();
  const open = (who = userId) => {
    const storage = createCmsStorage({
      store: delivery.store,
      records,
      site: SITE,
      slug,
      userId: who,
      now: () => now,
    });
    const handler = createContentHandler(storage, {
      maxCommitAttempts: 1,
      bodyCacheBytes: 0,
    });
    return async (method: string, params: unknown = {}) => {
      const res = await withConflictBlocks(
        await handler(
          new Request("http://x/rpc", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          }),
        ),
        storage.applyReads,
      );
      return (await res.json()) as {
        result?: Record<string, unknown> & {
          blocks?: Record<string, unknown>;
          versions?: Record<string, string | null>;
          revision?: string;
          resolvedRef?: string | null;
        };
        error?: { code: number; data?: Record<string, unknown> };
      };
    };
  };
  return { delivery, records, slug, open };
}

describe("blocks.list", () => {
  it("is the latest release with the draft on top, versioned by blockVersion", async () => {
    const { delivery, slug, open } = setup();
    await seedRelease(delivery.store, SITE, R1, {
      header: { t: "prod" },
      footer: { t: "prod" },
      banner: { t: "prod" },
    });
    await writeDraftObject(
      delivery.store,
      SITE,
      slug,
      { set: { header: { t: "draft" } }, delete: ["banner"], editors: {} },
      null,
    );
    const draftEtag = (await readDraftObject(delivery.store, SITE, slug)).etag!;
    const { result } = await open()("blocks.list");
    expect(result?.blocks).toEqual({
      footer: { t: "prod" },
      header: { t: "draft" },
    });
    expect(result?.versions).toEqual({
      footer: blockVersion({ t: "prod" }),
      header: blockVersion({ t: "draft" }),
    });
    // The protocol revision is the draft's ETag alone; the base is the release.
    expect(result?.revision).toBe(draftEtag.replaceAll('"', ""));
    expect(result?.resolvedRef).toBe(R1);
  });

  it("works before the first publish and before the draft object exists", async () => {
    const { open } = setup();
    const { result } = await open()("blocks.list");
    expect(result?.blocks).toEqual({});
    expect(result?.revision).toBe("none");
    expect(result?.resolvedRef).toBeNull();
  });
});

describe("blocks.apply (the save)", () => {
  it("writes the draft with If-None-Match first, stamping editors", async () => {
    const { delivery, slug, open } = setup();
    await seedRelease(delivery.store, SITE, R1, { header: { t: "prod" } });
    const reads: string[] = [];
    const get = delivery.store.get;
    delivery.store.get = async (key) => {
      reads.push(key);
      return get(key);
    };
    const { result } = await open()("blocks.apply", {
      set: { header: { t: "mine" } },
      ifMatch: { header: null },
    });
    // One strong read of the draft; no release read.
    expect(reads).toEqual([deliveryKeys.draft(SITE, slug)]);
    expect(result?.versions).toEqual({ header: blockVersion({ t: "mine" }) });
    const read = await readDraftObject(delivery.store, SITE, slug);
    expect(read.body).toEqual({
      set: { header: { t: "mine" } },
      delete: [],
      editors: { header: { userId: "usr_ana", at: 1793800000 } },
    });
  });

  it("checks ifMatch against the draft only: production's copy is null", async () => {
    const { delivery, open } = setup();
    await seedRelease(delivery.store, SITE, R1, { header: { t: "prod" } });
    // A first edit never conflicts, even though production has the block.
    const first = await open()("blocks.apply", {
      set: { header: { t: "a" } },
      ifMatch: { header: null },
    });
    expect(first.error).toBeUndefined();
    const stale = await open("usr_bob")("blocks.apply", {
      set: { header: { t: "b" } },
      ifMatch: { header: null },
    });
    expect(stale.error?.code).toBe(-32002);
  });

  it("a conflict carries value, version, editor and time from the save's own read", async () => {
    const { delivery, slug, open } = setup();
    await writeDraftObject(
      delivery.store,
      SITE,
      slug,
      {
        set: { header: { t: "theirs" } },
        delete: ["old"],
        editors: {
          header: { userId: "usr_bob", at: 1793800100 },
          old: { userId: "usr_cy", at: 1793800200 },
        },
      },
      null,
    );
    const answer = await open()("blocks.apply", {
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
    // All or nothing: the block that didn't conflict wasn't written either.
    const read = await readDraftObject(delivery.store, SITE, slug);
    expect(Object.keys(read.body.set)).toEqual(["header"]);
  });

  it("a lost race applies nothing and answers Unavailable, with no retry", async () => {
    const { delivery, slug, open } = setup();
    const call = open();
    let puts = 0;
    delivery.hooks.beforePut = (key) => {
      if (key !== deliveryKeys.draft(SITE, slug)) return;
      puts++;
      // Another process saved between this save's read and its PUT.
      delivery.hooks.beforePut = undefined;
      delivery.objects.set(key, {
        text: JSON.stringify({ set: { other: {} }, delete: [], editors: {} }),
        etag: '"elsewhere"',
        cacheControl: "",
      });
    };
    const answer = await call("blocks.apply", {
      set: { header: { t: 1 } },
      ifMatch: { header: null },
    });
    expect(answer.error?.code).toBe(-32008);
    expect(puts).toBe(1);
    expect(delivery.log.filter((l) => l.startsWith("refused")).length).toBe(1);
    const read = await readDraftObject(delivery.store, SITE, slug);
    expect(read.body.set).toEqual({ other: {} });
  });

  it("an R2 429/5xx on the conditional PUT is Unavailable, never a success", async () => {
    const { delivery, slug, open } = setup();
    delivery.hooks.beforePut = (key) => {
      throw new DeliveryUnavailableError(key, new Error("429 SlowDown"));
    };
    const answer = await open()("blocks.apply", {
      set: { a: { t: 1 } },
      ifMatch: { a: null },
    });
    expect(answer.error?.code).toBe(-32008);
    delivery.hooks.beforePut = undefined;
    expect((await readDraftObject(delivery.store, SITE, slug)).etag).toBeNull();
  });

  it("deletes record a tombstone and answer its version", async () => {
    const { delivery, slug, open } = setup();
    await seedRelease(delivery.store, SITE, R1, { banner: { t: "prod" } });
    const { result } = await open()("blocks.apply", {
      delete: ["banner"],
      ifMatch: { banner: null },
    });
    expect(result?.versions).toEqual({ banner: TOMBSTONE_VERSION });
    const read = await readDraftObject(delivery.store, SITE, slug);
    expect(read.body.delete).toEqual(["banner"]);
    expect(read.body.editors.banner?.userId).toBe("usr_ana");
  });
});

describe("changes.* and schema.get", () => {
  it("lists the draft's own names against the latest release, and discard drops them", async () => {
    const { delivery, slug, open } = setup();
    await seedRelease(delivery.store, SITE, R1, {
      header: { t: "prod" },
      banner: { t: "b" },
    });
    const call = open();
    await call("blocks.apply", {
      set: { header: { t: "draft" } },
      delete: ["banner"],
      ifMatch: { header: null, banner: null },
    });
    const list = await open()("changes.list");
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
    const discard = await open()("changes.discard", { names: ["header"] });
    expect(discard.error).toBeUndefined();
    const read = await readDraftObject(delivery.store, SITE, slug);
    expect(read.body).toEqual({
      set: {},
      delete: ["banner"],
      editors: { banner: { userId: "usr_ana", at: 1793800000 } },
    });
  });

  it("reads schema.json and revalidates the cached copy on every read", async () => {
    const { records, open } = setup();
    expect((await open()("schema.get")).result?.schema).toBeNull();
    await records.putSchema(SITE, '{"root":{}}');
    const first = await open()("schema.get");
    expect(first.result?.schema).toEqual({ root: {} });
    const second = await open()("schema.get");
    expect(second.result?.schema).toEqual({ root: {} });
    expect(records.reads.at(-1)?.ifNoneMatch).toBe('"schema1"');
  });
});
