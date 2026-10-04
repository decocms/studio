import { beforeAll, describe, expect, it } from "bun:test";
import {
  computeOverlayVersion,
  serializeBlock,
} from "@decocms/blocks/protocol";
import { draftOverlayFixtures } from "@decocms/blocks/protocol/conformance";
import type { RepoContentClient } from "@/git-providers";
import {
  buildDraftOverlay,
  deliveryKeys,
  draftOverlayPointer,
  draftOverlayStatus,
  MAX_OVERLAY_BLOCK_BYTES,
  prepareDraftOverlay,
} from "./draft-overlay";
import { fakeRepo, memoryStorage } from "./draft-overlay-test-helpers";
import { gitBlobSha } from "./read-decofile";

beforeAll(() => {
  // No disk blob cache: every body read goes through the fake client.
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

const block = (value: unknown) => serializeBlock(value);

describe("buildDraftOverlay", () => {
  it("is the cumulative file-level difference from the merge base", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: {
          "Header.json": block({ title: "old" }),
          "Footer.json": block({ links: 1 }),
          "OldPromotion.json": block({ on: true }),
        },
        draft: {
          "Header.json": block({ title: "new" }),
          "Footer.json": block({ links: 1 }),
          "Added.json": block({ fresh: true }),
        },
      },
    });
    const { overlay, blocks } = await buildDraftOverlay(client, null, "draft");
    expect(Object.keys(overlay.set).sort()).toEqual(["Added", "Header"]);
    expect(overlay.delete).toEqual(["OldPromotion"]);
    expect(JSON.parse(blocks.get(overlay.set.Header!)!)).toEqual({
      title: "new",
    });
  });

  it("never carries production changes the draft didn't make", async () => {
    // Production edited Footer after the draft branched: the draft's copy is
    // still the merge base's, so it inherits production, not the stale copy.
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: { "Footer.json": block({ v: 1 }) },
        draft: { "Footer.json": block({ v: 1 }) },
      },
    });
    const { overlay } = await buildDraftOverlay(client, null, "draft");
    expect(overlay).toEqual({ format: 1, set: {}, delete: [] });
    expect(await computeOverlayVersion(overlay)).toBe(
      draftOverlayFixtures.find((f) => f.id === "empty")!.version,
    );
  });

  it("matches the protocol's golden overlay hashes", async () => {
    const fixture = draftOverlayFixtures.find(
      (f) => f.id === "set-and-delete",
    )!;
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: {
          "HomeHero.json": block({ __resolveType: "hero", title: "Spring" }),
          "OldPromotion.json": block({ on: true }),
        },
        draft: { "HomeHero.json": block(fixture.blocks.HomeHero) },
      },
    });
    const { overlay } = await buildDraftOverlay(client, null, "draft");
    expect(overlay).toEqual(fixture.overlay);
    expect(await computeOverlayVersion(overlay)).toBe(fixture.version);
  });

  it("reads only changed bodies", async () => {
    const { client, reads } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: {
          "A.json": block({ a: 1 }),
          "B.json": block({ b: 1 }),
          "C.json": block({ c: 1 }),
        },
        draft: {
          "A.json": block({ a: 2 }),
          "B.json": block({ b: 1 }),
          "C.json": block({ c: 1 }),
        },
      },
    });
    await buildDraftOverlay(client, null, "draft");
    expect(reads).toEqual([gitBlobSha(block({ a: 2 }))]);
  });

  it("treats a respelled file of one name as a replacement, not a deletion", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: { "pages%2Fhome.json": block({ path: "/", v: 1 }) },
        draft: { "pages%2fhome.json": block({ path: "/", v: 2 }) },
      },
    });
    const { overlay } = await buildDraftOverlay(client, null, "draft");
    expect(Object.keys(overlay.set)).toEqual(["pages/home"]);
    expect(overlay.delete).toEqual([]);
  });

  it("keeps an entry named __proto__ as an entry", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: { base: {}, draft: { "__proto__.json": block({ x: 1 }) } },
    });
    const { overlay } = await buildDraftOverlay(client, null, "draft");
    expect(Object.hasOwn(overlay.set, "__proto__")).toBe(true);
  });

  it("reads the app root's saved blocks in a monorepo", async () => {
    const { client } = fakeRepo({
      packagePath: "apps/store",
      mergeBase: "base",
      commits: { base: {}, draft: { "Hero.json": block({ x: 1 }) } },
    });
    const { overlay } = await buildDraftOverlay(client, "apps/store", "draft");
    expect(Object.keys(overlay.set)).toEqual(["Hero"]);
  });

  it("refuses changes larger than the overlay limit", async () => {
    const big = "x".repeat(MAX_OVERLAY_BLOCK_BYTES / 2 + 1);
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: {
        base: {},
        draft: { "A.json": block({ big }), "B.json": block({ big }) },
      },
    });
    await expect(buildDraftOverlay(client, null, "draft")).rejects.toThrow(
      /exceed/,
    );
  });
});

describe("prepareDraftOverlay", () => {
  const scopeFor = (client: RepoContentClient, revision = "draft") => ({
    client,
    packagePath: null,
    site: "acme",
    revision,
  });

  it("uploads blocks, then the manifest, then the commit's marker", async () => {
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: { base: {}, draft: { "Hero.json": block({ x: 1 }) } },
    });
    const { store, objects, puts } = memoryStorage();
    const version = await prepareDraftOverlay(scopeFor(client), store);
    const manifest = JSON.parse(
      objects.get(deliveryKeys.manifest("acme", version))!,
    );
    expect(puts).toEqual([
      deliveryKeys.block("acme", manifest.set.Hero),
      deliveryKeys.manifest("acme", version),
      deliveryKeys.prepared("acme", "draft"),
    ]);
    expect(await computeOverlayVersion(manifest)).toBe(version);
  });

  it("reports preparing, then ready, for one saved commit", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { client } = fakeRepo({
      mergeBase: "base",
      commits: { base: {}, slow: { "Hero.json": block({ x: 1 }) } },
    });
    const slow = {
      ...client,
      compareDetailed: async (a: string, b: string) => {
        await gate;
        return client.compareDetailed(a, b);
      },
    } as RepoContentClient;
    const { store } = memoryStorage();
    const scope = scopeFor(slow, "slow");
    expect(await draftOverlayStatus(scope, { store, waitMs: 5 })).toEqual({
      status: "preparing",
    });
    release();
    const ready = await draftOverlayStatus(scope, { store });
    expect(ready.status).toBe("ready");
    // Now from storage, without preparing again.
    expect(await draftOverlayStatus(scope, { store, waitMs: 0 })).toEqual(
      ready,
    );
  });

  it("reports a failed preparation instead of preparing forever", async () => {
    const { client } = fakeRepo({ mergeBase: "base", commits: { base: {} } });
    const { store } = memoryStorage();
    const status = await draftOverlayStatus(scopeFor(client, "gone"), {
      store,
    });
    expect(status).toEqual({
      status: "failed",
      error: "unknown commit gone",
    });
  });
});

describe("draftOverlayPointer", () => {
  it("names the site's drafts on the delivery host, grant as the query", () => {
    expect(
      draftOverlayPointer({
        site: "acme",
        version: "f".repeat(64),
        grant: "g.h",
      }),
    ).toBe(
      `delivery.decocms.com/sites/acme/drafts?token=g.h@${"f".repeat(64)}`,
    );
  });
});
