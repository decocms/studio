import { beforeEach, describe, expect, it } from "bun:test";
import { clearRevisionCache, serializeRevisionData } from "./cms-release";
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
  it("lists revision folders newest first, 50 a page, walking previous across pages", async () => {
    const delivery = memoryDeliveryStore();
    const live: string[] = [];
    // 60 publishes, every 7th lost its race (written, never named by latest.json).
    for (let i = 0; i < 60; i++) {
      const id = newRevisionId(clock++);
      if (i % 7 === 3) {
        await delivery.store.putText(
          deliveryKeys.revisionData(SITE, id),
          serializeRevisionData({}),
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
      deliveryKeys.revisionData(SITE, crashed),
      "{}",
      "",
    );

    const first = await listCmsReleases(delivery.store, SITE, null);
    expect(first.live).toBe(live.at(-1)!);
    expect(first.revisions.length).toBe(RELEASES_PAGE_SIZE - 1);
    expect(first.revisions.find((r) => r.id === crashed)).toBeUndefined();
    const ids = first.revisions.map((r) => r.id);
    expect(ids).toEqual([...ids].sort());
    // The newest folder is a lost race, listed above the live one.
    expect(first.revisions[0]?.status).toBe("never-live");
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
      if (row.id === live.at(-1)) continue;
      expect(row.status).toBe(
        live.includes(row.id) ? "was-live" : "never-live",
      );
    }
    expect(decodeCursor(first.nextCursor!)?.expect).toBeTruthy();
  });

  it("an unreadable meta.json is a row with its id only, and the walk stops at it", async () => {
    for (const broken of ["unparseable", "missing", "get-fails"] as const) {
      clearRevisionCache();
      const delivery = memoryDeliveryStore();
      const ids = Array.from({ length: 4 }, () => newRevisionId(clock++));
      for (const [i, id] of ids.entries())
        await seedRelease(delivery.store, SITE, id, { n: { i } });
      // ids are newest-last; the listing is newest first: r4, r3, r2, r1.
      const [r1, r2, r3, r4] = ids as [string, string, string, string];
      const key = deliveryKeys.revisionMeta(SITE, r3);
      if (broken === "unparseable")
        delivery.objects.set(key, {
          text: "{nope",
          etag: '"x"',
          cacheControl: "",
        });
      else if (broken === "missing") delivery.objects.delete(key);
      else {
        const get = delivery.store.get.bind(delivery.store);
        delivery.store.get = async (k) => {
          if (k === key)
            throw new DeliveryUnavailableError(k, new Error("503"));
          return get(k);
        };
      }
      const page = await listCmsReleases(delivery.store, SITE, null);
      expect(page.revisions).toEqual([
        expect.objectContaining({ id: r4, status: "current" }),
        { id: r3, status: "unreadable" },
        // Past the broken link the walk can't reach them: never live.
        expect.objectContaining({ id: r2, status: "never-live" }),
        expect.objectContaining({ id: r1, status: "never-live" }),
      ]);
    }
  });

  it("an unreadable meta.json off the walk doesn't stop it; a crash off the walk is still skipped", async () => {
    const delivery = memoryDeliveryStore();
    const r1 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r1, { n: {} });
    const lost = newRevisionId(clock++);
    await delivery.store.putText(
      deliveryKeys.revisionData(SITE, lost),
      serializeRevisionData({}),
      "",
    );
    await delivery.store.putText(
      deliveryKeys.revisionMeta(SITE, lost),
      "[]",
      "",
    );
    const crashed = newRevisionId(clock++);
    await delivery.store.putText(
      deliveryKeys.revisionData(SITE, crashed),
      "{}",
      "",
    );
    const r2 = newRevisionId(clock++);
    await seedRelease(delivery.store, SITE, r2, { n: {} }, { previous: r1 });
    const page = await listCmsReleases(delivery.store, SITE, null);
    expect(page.revisions.map((r) => [r.id, r.status])).toEqual([
      [r2, "current"],
      [lost, "unreadable"],
      [r1, "was-live"],
    ]);
  });

  it("the stopped walk rides in the cursor: later pages are never live", async () => {
    clearRevisionCache();
    const delivery = memoryDeliveryStore();
    const ids: string[] = [];
    for (let i = 0; i < RELEASES_PAGE_SIZE + 2; i++) {
      const id = newRevisionId(clock++);
      await seedRelease(delivery.store, SITE, id, { n: { i } });
      ids.push(id);
    }
    const newest = [...ids].reverse() as [string, string, ...string[]];
    delivery.objects.set(deliveryKeys.revisionMeta(SITE, newest[1]), {
      text: "{nope",
      etag: '"x"',
      cacheControl: "",
    });
    const first = await listCmsReleases(delivery.store, SITE, null);
    expect(first.revisions[1]).toEqual({ id: newest[1], status: "unreadable" });
    expect(decodeCursor(first.nextCursor!)?.expect).toBeNull();
    const second = await listCmsReleases(
      delivery.store,
      SITE,
      first.nextCursor,
    );
    expect(second.revisions.map((r) => r.status)).toEqual([
      "never-live",
      "never-live",
    ]);
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
