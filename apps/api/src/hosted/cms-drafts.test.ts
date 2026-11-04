import { describe, expect, it } from "bun:test";
import {
  createCmsDrafts,
  draftResource,
  isValidDraftName,
  parseDraftBody,
  stampEditors,
} from "./cms-drafts";
import { memoryDraftTable } from "./cms-test-helpers";
import { deliveryKeys } from "./delivery-store";
import { memoryDeliveryStore } from "./hosted-test-helpers";

const SITE = "acme";

describe("cms drafts", () => {
  it("creating is idempotent: concurrent creates end on one row and one slug", async () => {
    const delivery = memoryDeliveryStore();
    const table = memoryDraftTable();
    const drafts = createCmsDrafts({ table, store: delivery.store });
    const [a, b] = await Promise.all([
      drafts.ensure(SITE, "pdp-copy", { userId: "u1", via: "cli" }),
      drafts.ensure(SITE, "pdp-copy", { userId: "u2", via: "studio" }),
    ]);
    expect(a.row.slug).toBe(b.row.slug);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.etag).not.toBeNull();
    expect(
      JSON.parse(
        delivery.objects.get(deliveryKeys.draft(SITE, a.row.slug))!.text,
      ),
    ).toEqual({
      set: {},
      delete: [],
      editors: {},
    });
    expect(await drafts.list(SITE)).toHaveLength(1);
  });

  it("discard deletes the row and the object", async () => {
    const delivery = memoryDeliveryStore();
    const drafts = createCmsDrafts({
      table: memoryDraftTable(),
      store: delivery.store,
    });
    const { row } = await drafts.ensure(SITE, "x", {
      userId: "u1",
      via: "token",
    });
    expect(await drafts.discard(SITE, "x")).toBe(true);
    expect(await drafts.resolve(SITE, "x")).toBeNull();
    expect(delivery.objects.has(deliveryKeys.draft(SITE, row.slug))).toBe(
      false,
    );
    expect(await drafts.discard(SITE, "x")).toBe(false);
  });

  it("names follow the branch rule, at most 255 characters", () => {
    expect(isValidDraftName("threads/abc-123")).toBe(true);
    expect(isValidDraftName("-x")).toBe(false);
    expect(isValidDraftName("a b")).toBe(false);
    expect(isValidDraftName("a".repeat(256))).toBe(false);
  });

  it("the resource carries the pointer and the preview link", () => {
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
      "https://www.acme.com",
    );
    expect(resource.pointer).toBe(
      "delivery.decocms.com/sites/acme/drafts/Q2xhcmFRMlhvYjNOdGFXNW.json@abc123",
    );
    expect(resource.previewUrl).toBe(
      `https://www.acme.com/?__draft=${encodeURIComponent(resource.pointer!)}`,
    );
  });
});

describe("editors", () => {
  it("stamps names a write changes, keeps untouched ones, drops gone ones", () => {
    const before = parseDraftBody({
      set: { a: { v: 1 }, b: { v: 1 } },
      delete: ["c"],
      editors: {
        a: { userId: "old", at: 1 },
        b: { userId: "old", at: 1 },
        c: { userId: "old", at: 1 },
      },
    });
    expect(
      stampEditors(
        before,
        { set: { a: { v: 2 }, b: { v: 1 } }, delete: ["d"] },
        "new",
        9,
      ),
    ).toEqual({
      a: { userId: "new", at: 9 },
      b: { userId: "old", at: 1 },
      d: { userId: "new", at: 9 },
    });
  });

  it("parses a draft without editors, and drops malformed editor entries", () => {
    expect(parseDraftBody({ set: {}, delete: [] }).editors).toEqual({});
    expect(
      parseDraftBody({
        set: {},
        delete: [],
        editors: { a: { userId: 1 }, b: { userId: "u", at: 2 } },
      }).editors,
    ).toEqual({ b: { userId: "u", at: 2 } });
    expect(() => parseDraftBody({ set: [] })).toThrow();
  });
});
