import { beforeEach, describe, expect, it } from "bun:test";
import { clearRevisionCache, serializeIndex } from "./cms-release";
import {
  decodeCursor,
  listCmsReleases,
  RELEASES_PAGE_SIZE,
} from "./cms-releases";
import { seedRelease } from "./cms-test-helpers";
import { DeliveryUnavailableError, deliveryKeys } from "./delivery-store";
import { memoryDeliveryStore } from "./hosted-test-helpers";
import { newRevisionId } from "./revision-id";

const SITE = "acme";
let clock = Date.parse("2026-11-01T00:00:00.000Z");

beforeEach(() => clearRevisionCache());

describe("listCmsReleases", () => {
  it("lists every revision folder newest first, 50 a page, marking only the current one", async () => {
    const delivery = memoryDeliveryStore();
    const live: string[] = [];
    // 60 publishes, every 7th lost its race (written, never named by latest.json).
    for (let i = 0; i < 60; i++) {
      const id = newRevisionId(clock++);
      if (i % 7 === 3) {
        await delivery.store.putText(
          deliveryKeys.revisionIndex(SITE, id),
          serializeIndex({ revision: id, sequence: 1, blocks: {} }),
          "",
        );
        await delivery.store.putJson(
          deliveryKeys.revisionMeta(SITE, id),
          {
            previous: live.at(-1) ?? null,
            author: "u",
            via: "studio",
            message: "lost",
            publishedAt: "2026-11-01T00:00:00.000Z",
          },
          "",
        );
      } else {
        await seedRelease(delivery.store, SITE, id, { n: { i } });
        live.push(id);
      }
    }
    // A crash before meta.json: skipped.
    const crashed = newRevisionId(clock++);
    await delivery.store.putText(
      deliveryKeys.revisionIndex(SITE, crashed),
      "{}",
      "",
    );

    const first = await listCmsReleases(delivery.store, SITE, null);
    expect(first.live).toBe(live.at(-1)!);
    expect(first.revisions.length).toBe(RELEASES_PAGE_SIZE - 1);
    expect(first.revisions.find((r) => r.id === crashed)).toBeUndefined();
    const ids = first.revisions.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    // The newest folder is a lost race: listed above the live one, as any other.
    expect(first.revisions[0]?.status).toBe("listed");
    expect(first.revisions[1]).toMatchObject({
      id: live.at(-1),
      status: "current",
    });
    expect(first.nextCursor).not.toBeNull();

    const second = await listCmsReleases(
      delivery.store,
      SITE,
      first.nextCursor,
    );
    const all = [...first.revisions, ...second.revisions];
    expect(all.length).toBe(60);
    expect(second.nextCursor).toBeNull();
    for (const row of all) {
      expect(row.status).toBe(row.id === live.at(-1) ? "current" : "listed");
    }
    expect(decodeCursor(first.nextCursor!)).toEqual({
      token: expect.any(String),
    });
  });

  it("an unparseable meta.json is a row with its id only; the rows around it are listed", async () => {
    const delivery = memoryDeliveryStore();
    const ids = Array.from({ length: 4 }, () => newRevisionId(clock++));
    for (const [i, id] of ids.entries())
      await seedRelease(delivery.store, SITE, id, { n: { i } });
    // ids are newest-last; the listing is newest first: r4, r3, r2, r1.
    const [r1, r2, r3, r4] = ids as [string, string, string, string];
    delivery.objects.set(deliveryKeys.revisionMeta(SITE, r3), {
      text: "{nope",
      etag: '"x"',
      cacheControl: "",
    });
    const page = await listCmsReleases(delivery.store, SITE, null);
    expect(page.revisions).toEqual([
      expect.objectContaining({ id: r4, status: "current" }),
      { id: r3, status: "unreadable" },
      expect.objectContaining({ id: r2, status: "listed" }),
      expect.objectContaining({ id: r1, status: "listed" }),
    ]);
  });

  it("a meta.json GET that fails (R2 429/5xx/network) fails the list, not a row", async () => {
    const delivery = memoryDeliveryStore();
    const r1 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r1, { n: {} });
    const r2 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r2, { n: {} });
    const key = deliveryKeys.revisionMeta(SITE, r1);
    const get = delivery.store.get.bind(delivery.store);
    delivery.store.get = async (k) => {
      if (k === key) throw new DeliveryUnavailableError(k, new Error("503"));
      return get(k);
    };
    await expect(
      listCmsReleases(delivery.store, SITE, null),
    ).rejects.toBeInstanceOf(DeliveryUnavailableError);
    // Not cached: the next list reads it again.
    delivery.store.get = get;
    expect(
      (await listCmsReleases(delivery.store, SITE, null)).revisions.map((r) => [
        r.id,
        r.status,
      ]),
    ).toEqual([
      [r2, "current"],
      [r1, "listed"],
    ]);
  });

  it("a folder without meta.json is skipped, unless latest.json names it", async () => {
    const delivery = memoryDeliveryStore();
    const r1 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r1, { n: {} });
    const crashed = newRevisionId(clock++);
    await delivery.store.putText(
      deliveryKeys.revisionIndex(SITE, crashed),
      "{}",
      "",
    );
    const r2 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r2, { n: {} });
    expect(
      (await listCmsReleases(delivery.store, SITE, null)).revisions.map((r) => [
        r.id,
        r.status,
      ]),
    ).toEqual([
      [r2, "current"],
      [r1, "listed"],
    ]);
    clearRevisionCache();
    delivery.objects.delete(deliveryKeys.revisionMeta(SITE, r2));
    expect(
      (await listCmsReleases(delivery.store, SITE, null)).revisions,
    ).toEqual([
      { id: r2, status: "unreadable" },
      expect.objectContaining({ id: r1, status: "listed" }),
    ]);
  });

  it("rejects a cursor this Studio didn't write", async () => {
    const delivery = memoryDeliveryStore();
    await expect(
      listCmsReleases(delivery.store, SITE, "not-a-cursor"),
    ).rejects.toThrow("invalid cursor");
  });

  it("a fixed meta.json shows on the next list: failures aren't cached", async () => {
    clearRevisionCache();
    const delivery = memoryDeliveryStore();
    const r1 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r1, { n: {} });
    const key = deliveryKeys.revisionMeta(SITE, r1);
    const good = delivery.objects.get(key)!;
    delivery.objects.set(key, { text: "{nope", etag: '"x"', cacheControl: "" });
    expect(
      (await listCmsReleases(delivery.store, SITE, null)).revisions,
    ).toEqual([{ id: r1, status: "unreadable" }]);
    delivery.objects.set(key, good);
    expect(
      (await listCmsReleases(delivery.store, SITE, null)).revisions[0],
    ).toMatchObject({
      id: r1,
      status: "current",
      meta: { author: "usr_seed" },
    });
  });

  it("is empty before the first publish", async () => {
    const delivery = memoryDeliveryStore();
    expect(await listCmsReleases(delivery.store, SITE, null)).toEqual({
      live: null,
      revisions: [],
      nextCursor: null,
    });
  });
});
