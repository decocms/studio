import { describe, expect, it } from "bun:test";
import {
  createCmsDrafts,
  draftResource,
  draftToken,
  isValidDraftName,
  parseDraftFile,
  readDraftIndex,
  readDraftState,
  updateDraftIndex,
} from "./cms-drafts";
import {
  deleteFile,
  memoryDraftTable,
  seedDraftFile,
  setFile,
} from "./cms-test-helpers";
import {
  DeliveryUnavailableError,
  deliveryKeys,
  newDraftSlug,
} from "./delivery-store";
import { memoryDeliveryStore } from "./hosted-test-helpers";

const SITE = "acme";
const R1 = "fe6c5e0d97ff-0193a1f2-6800-7c3e-9d2a-4b8e1f0c7a55";

describe("cms drafts", () => {
  it("creating is idempotent: concurrent creates end on one row, one slug and one empty index", async () => {
    const delivery = memoryDeliveryStore();
    const table = memoryDraftTable();
    const drafts = createCmsDrafts({ table, store: delivery.store });
    const [a, b] = await Promise.all([
      drafts.ensure(SITE, "pdp-copy", { userId: "u1", via: "cli" }),
      drafts.ensure(SITE, "pdp-copy", { userId: "u2", via: "studio" }),
    ]);
    expect(a.row.slug).toBe(b.row.slug);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.state.index.etag).not.toBeNull();
    expect(
      JSON.parse(
        delivery.objects.get(deliveryKeys.draftIndex(SITE, a.row.slug))!.text,
      ),
    ).toEqual({ names: [] });
    // Created with If-None-Match: *, once.
    expect(delivery.log.filter((l) => l.startsWith("put")).length).toBe(1);
    expect(await drafts.list(SITE)).toHaveLength(1);
  });

  it("resolve reads the index and every file it lists", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createCmsDrafts({
      table: memoryDraftTable(),
      store: delivery.store,
    });
    const { row } = await drafts.ensure(SITE, "x", {
      userId: "u1",
      via: "studio",
    });
    await seedDraftFile(
      delivery.store,
      SITE,
      row.slug,
      "home",
      setFile({ a: 1 }),
    );
    await seedDraftFile(delivery.store, SITE, row.slug, "old", deleteFile());
    // Listed, with no file: absent.
    await updateDraftIndex(delivery.store, SITE, row.slug, (n) => [
      ...n,
      "ghost",
    ]);
    const found = await drafts.resolve(SITE, "x");
    expect(found?.state.index.names).toEqual(["ghost", "home", "old"]);
    expect(found?.state.files.get("home")?.file).toEqual(setFile({ a: 1 }));
    expect(found?.state.files.get("old")?.file?.operation).toBe("delete");
    expect(found?.state.files.get("ghost")).toEqual({ file: null, etag: null });
  });

  it("discard empties the index, then deletes every listed file, then the index, then the row", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createCmsDrafts({
      table: memoryDraftTable(),
      store: delivery.store,
    });
    const { row } = await drafts.ensure(SITE, "x", {
      userId: "u1",
      via: "token",
    });
    await seedDraftFile(delivery.store, SITE, row.slug, "b", setFile({ b: 1 }));
    await seedDraftFile(delivery.store, SITE, row.slug, "a", setFile({ a: 1 }));
    delivery.log.length = 0;
    expect(await drafts.discard(SITE, "x")).toBe(true);
    expect(delivery.log).toEqual([
      `put ${deliveryKeys.draftIndex(SITE, row.slug)}`,
      `delete ${deliveryKeys.draftFile(SITE, row.slug, "a")}`,
      `delete ${deliveryKeys.draftFile(SITE, row.slug, "b")}`,
      `delete ${deliveryKeys.draftIndex(SITE, row.slug)}`,
    ]);
    expect(await drafts.resolve(SITE, "x")).toBeNull();
    expect(delivery.objects.size).toBe(0);
    expect(await drafts.discard(SITE, "x")).toBe(false);
  });

  it("discard deletes the objects before the row: a failed delete keeps the row, so it can be retried", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createCmsDrafts({
      table: memoryDraftTable(),
      store: delivery.store,
    });
    const { row } = await drafts.ensure(SITE, "x", {
      userId: "u1",
      via: "token",
    });
    const remove = delivery.store.delete.bind(delivery.store);
    delivery.store.delete = async () => {
      throw new Error("R2 is down");
    };
    await expect(drafts.discard(SITE, "x")).rejects.toThrow("R2 is down");
    expect((await drafts.resolve(SITE, "x"))?.row.slug).toBe(row.slug);
    delivery.store.delete = remove;
    expect(await drafts.discard(SITE, "x")).toBe(true);
    expect(await drafts.resolve(SITE, "x")).toBeNull();
    expect(delivery.objects.has(deliveryKeys.draftIndex(SITE, row.slug))).toBe(
      false,
    );
  });

  it("discard never leaves a listed name whose file is gone", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createCmsDrafts({
      table: memoryDraftTable(),
      store: delivery.store,
    });
    const { row } = await drafts.ensure(SITE, "x", {
      userId: "u1",
      via: "token",
    });
    await seedDraftFile(delivery.store, SITE, row.slug, "a", setFile({ a: 1 }));
    await seedDraftFile(delivery.store, SITE, row.slug, "b", setFile({ b: 1 }));
    const indexKey = deliveryKeys.draftIndex(SITE, row.slug);
    const remove = delivery.store.delete.bind(delivery.store);
    const seen: string[][] = [];
    delivery.store.delete = async (key: string) => {
      const index = delivery.objects.get(indexKey);
      if (index && key !== indexKey) {
        seen.push((JSON.parse(index.text) as { names: string[] }).names);
      }
      return remove(key);
    };
    expect(await drafts.discard(SITE, "x")).toBe(true);
    expect(seen).toEqual([[], []]);
  });

  it("discard deletes a name a save listed while the index was being emptied", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createCmsDrafts({
      table: memoryDraftTable(),
      store: delivery.store,
    });
    const { row } = await drafts.ensure(SITE, "x", {
      userId: "u1",
      via: "token",
    });
    await seedDraftFile(delivery.store, SITE, row.slug, "a", setFile({ a: 1 }));
    const indexKey = deliveryKeys.draftIndex(SITE, row.slug);
    const putJson = delivery.store.putJson.bind(delivery.store);
    let raced = false;
    delivery.store.putJson = async (key, value, cacheControl, condition) => {
      if (key === indexKey && !raced) {
        raced = true;
        await seedDraftFile(
          delivery.store,
          SITE,
          row.slug,
          "late",
          setFile({ late: 1 }),
        );
      }
      return putJson(key, value, cacheControl, condition);
    };
    expect(await drafts.discard(SITE, "x")).toBe(true);
    expect(raced).toBe(true);
    expect(delivery.objects.size).toBe(0);
  });

  it("names follow the branch rule, at most 255 characters", () => {
    expect(isValidDraftName("threads/abc-123")).toBe(true);
    expect(isValidDraftName("-x")).toBe(false);
    expect(isValidDraftName("a b")).toBe(false);
    expect(isValidDraftName("a".repeat(256))).toBe(false);
  });

  it("the resource points at the draft index, versioned by the draft token", () => {
    const resource = draftResource(
      {
        site: SITE,
        name: "n",
        slug: "Q2xhcmFRMlhvYjNOdGFXNW",
        createdBy: "u1",
        via: "cli",
        createdAt: "2026-11-04T10:00:00.000Z",
      },
      '"abc123"',
      "TOKENtokenTOKENtoken01",
      "https://www.acme.com",
    );
    expect(resource.etag).toBe("abc123");
    expect(resource.pointer).toBe(
      "delivery.decocms.com/sites/acme/drafts/Q2xhcmFRMlhvYjNOdGFXNW/index.json@TOKENtokenTOKENtoken01",
    );
    expect(resource.previewUrl).toBe(
      `https://www.acme.com/?__draft=${encodeURIComponent(resource.pointer!)}`,
    );
  });
});

describe("the draft index", () => {
  it("is kept sorted and deduped; an unchanged index isn't written", async () => {
    const delivery = memoryDeliveryStore();
    const slug = newDraftSlug();
    await updateDraftIndex(delivery.store, SITE, slug, () => ["b", "a", "b"]);
    expect((await readDraftIndex(delivery.store, SITE, slug)).names).toEqual([
      "a",
      "b",
    ]);
    const puts = delivery.log.length;
    await updateDraftIndex(delivery.store, SITE, slug, (n) => [...n, "a"]);
    expect(delivery.log.length).toBe(puts);
  });

  it("rereads and reapplies the change on 412, up to 3 attempts", async () => {
    const delivery = memoryDeliveryStore();
    const slug = newDraftSlug();
    const key = deliveryKeys.draftIndex(SITE, slug);
    await updateDraftIndex(delivery.store, SITE, slug, () => ["a"]);
    // Another writer lands before each of our first two writes.
    let races = 2;
    delivery.hooks.beforePut = (k) => {
      if (k !== key || races === 0) return;
      races--;
      const current = delivery.objects.get(key)!;
      const names = JSON.parse(current.text).names as string[];
      delivery.objects.set(key, {
        ...current,
        text: JSON.stringify({ names: [...names, `other${races}`].sort() }),
        etag: `"race${races}"`,
      });
    };
    const read = await updateDraftIndex(delivery.store, SITE, slug, (n) => [
      ...n,
      "mine",
    ]);
    expect(read.names).toEqual(["a", "mine", "other0", "other1"]);
    expect(delivery.log.filter((l) => l === `refused ${key}`)).toHaveLength(2);
  });

  it("gives up as Unavailable after 3 lost races", async () => {
    const delivery = memoryDeliveryStore();
    const slug = newDraftSlug();
    const key = deliveryKeys.draftIndex(SITE, slug);
    await updateDraftIndex(delivery.store, SITE, slug, () => ["a"]);
    let n = 0;
    delivery.hooks.beforePut = (k) => {
      if (k !== key) return;
      const current = delivery.objects.get(key)!;
      delivery.objects.set(key, { ...current, etag: `"moved${++n}"` });
    };
    await expect(
      updateDraftIndex(delivery.store, SITE, slug, (names) => [...names, "x"]),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
    expect(n).toBe(3);
  });
});

describe("draft files", () => {
  it("parse the three operations and refuse anything else", () => {
    expect(parseDraftFile(setFile({ a: 1 }))).toEqual(setFile({ a: 1 }));
    expect(parseDraftFile(deleteFile())?.operation).toBe("delete");
    expect(
      parseDraftFile({ operation: "published", revision: R1, version: null }),
    ).toEqual({ operation: "published", revision: R1, version: null });
    expect(parseDraftFile({ operation: "set", data: [] })).toBeNull();
    expect(parseDraftFile({ operation: "set", data: {}, user: 1 })).toBeNull();
    expect(parseDraftFile({ operation: "move" })).toBeNull();
    expect(parseDraftFile(null)).toBeNull();
  });

  it("a malformed file fails the read", async () => {
    const delivery = memoryDeliveryStore();
    const slug = newDraftSlug();
    await updateDraftIndex(delivery.store, SITE, slug, () => ["a"]);
    await delivery.store.putJson(
      deliveryKeys.draftFile(SITE, slug, "a"),
      { set: {} },
      "",
    );
    await expect(readDraftState(delivery.store, SITE, slug)).rejects.toThrow(
      "malformed",
    );
  });
});

describe("draftToken", () => {
  it("moves with latest, the index or any existing file, and is 22 characters", async () => {
    const delivery = memoryDeliveryStore();
    const slug = newDraftSlug();
    await updateDraftIndex(delivery.store, SITE, slug, () => []);
    const empty = await readDraftState(delivery.store, SITE, slug);
    const t0 = draftToken(null, empty);
    expect(t0).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(draftToken(R1, empty)).not.toBe(t0);
    expect(draftToken(null, empty)).toBe(t0);
    await seedDraftFile(delivery.store, SITE, slug, "a", setFile({ a: 1 }));
    const one = await readDraftState(delivery.store, SITE, slug);
    const t1 = draftToken(null, one);
    expect(t1).not.toBe(t0);
    // An autosave of a listed name moves only its file: still a new token.
    const before = delivery.objects.get(
      deliveryKeys.draftIndex(SITE, slug),
    )!.etag;
    await seedDraftFile(delivery.store, SITE, slug, "a", setFile({ a: 2 }));
    expect(
      delivery.objects.get(deliveryKeys.draftIndex(SITE, slug))!.etag,
    ).toBe(before);
    expect(
      draftToken(null, await readDraftState(delivery.store, SITE, slug)),
    ).not.toBe(t1);
  });
});
