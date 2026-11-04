import { beforeEach, describe, expect, it } from "bun:test";
import { clearRevisionCache, serializeRevisionData } from "./cms-release";
import {
  decodeCursor,
  listCmsReleases,
  RELEASES_PAGE_SIZE,
} from "./cms-releases";
import { seedRelease } from "./cms-test-helpers";
import { deliveryKeys } from "./delivery-store";
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

  it("is empty before the first publish", async () => {
    const delivery = memoryDeliveryStore();
    expect(await listCmsReleases(delivery.store, SITE, null)).toEqual({
      live: null,
      revisions: [],
      nextCursor: null,
    });
  });
});
