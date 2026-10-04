/**
 * The whole draft preview loop, end to end in one process: Studio prepares
 * overlays from saved commits (`prepareDraftOverlay`), serves them
 * (`createDraftDeliveryRoutes`), and a hosted site's real
 * `createCMS(...).forDraft(pointer)` reads them over its own production
 * content (blocks docs: /next/content-delivery#exact-draft-previews).
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  createCMS,
  formatDraftPointer,
  parseDraftPointer,
  resetForTests,
} from "@decocms/blocks";
import { serializeBlock } from "@decocms/blocks/protocol";
import { fakeRepo, memoryStorage } from "@/decofile/draft-overlay-test-helpers";
import {
  deliveryKeys,
  draftOverlayPointer,
  prepareDraftOverlay,
} from "@/decofile/draft-overlay";
import { signOverlayGrant, siteToken } from "@/decofile/draft-token";
import { createDraftDeliveryRoutes } from "./draft-delivery";

beforeAll(() => {
  process.env.FAST_PREVIEW_CACHE_DIR = "";
});

const SITE = "acme";
const post = (value: Record<string, unknown>) => ({
  __resolveType: "post",
  ...value,
});
const file = (value: Record<string, unknown>) => serializeBlock(post(value));
const banner = (fallback: string, summer: string) => ({
  __resolveType: "multivariate",
  variants: [
    { rule: { __resolveType: "never" }, value: fallback },
    { rule: { __resolveType: "never" }, value: summer },
  ],
});

/** The production branch at the merge base, and two saved draft commits. */
const COMMITS = {
  base: {
    "Hero.json": file({ title: "published hero" }),
    "Promo.json": file({ title: "published promo" }),
    "Footer.json": file({ title: "footer at base" }),
    "Banner.json": serializeBlock(banner("published a", "published b")),
  },
  // Change Hero, delete Promo, add New, and edit the Banner's variants.
  draft1: {
    "Hero.json": file({ title: "draft hero" }),
    "Footer.json": file({ title: "footer at base" }),
    "New.json": file({ title: "new block" }),
    "Banner.json": serializeBlock(banner("draft fallback", "draft summer")),
  },
  // A second save: same Hero/New/Banner bodies, one more change to Footer.
  draft2: {
    "Hero.json": file({ title: "draft hero" }),
    "Footer.json": file({ title: "draft footer" }),
    "New.json": file({ title: "new block" }),
    "Banner.json": serializeBlock(banner("draft fallback", "draft summer")),
  },
};

/** The site's own production snapshot: newer than the merge base for Footer. */
const PRODUCTION = {
  revision: "prod-1",
  blocks: {
    Hero: post({ title: "published hero" }),
    Promo: post({ title: "published promo" }),
    Footer: post({ title: "footer in production" }),
    Banner: banner("published a", "published b"),
  },
};

async function setup() {
  const { client } = fakeRepo({ mergeBase: "base", commits: COMMITS });
  const { store, objects } = memoryStorage();
  const prepare = (revision: string) =>
    prepareDraftOverlay(
      { client, packagePath: null, site: SITE, revision },
      store,
    );
  const app = createDraftDeliveryRoutes(() => store);
  const manifestOf = (version: string) =>
    JSON.parse(objects.get(deliveryKeys.manifest(SITE, version))!) as {
      set: Record<string, string>;
      delete: string[];
    };
  const pointerFor = (version: string) =>
    draftOverlayPointer({
      site: SITE,
      version,
      grant: signOverlayGrant({ site: SITE, version }).token,
    });

  // Every request the site makes, answered by Studio's delivery routes.
  const requested: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requested.push(`${url.host}${url.pathname}`);
    if (url.host !== "delivery.decocms.com") {
      return new Response("unexpected host", { status: 599 });
    }
    return app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;

  const cms = createCMS({
    blocks: { post: (props: unknown) => props },
    content: PRODUCTION,
    site: SITE,
    token: siteToken(SITE),
  });
  return { app, cms, prepare, manifestOf, pointerFor, requested };
}

const manifestPath = (v: string) =>
  `delivery.decocms.com/sites/${SITE}/drafts/${v}.json`;
const blockPath = (h: string) =>
  `delivery.decocms.com/sites/${SITE}/draft-blocks/${h}.json`;

describe("draft preview loop: Studio overlay -> delivery -> cms.forDraft", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetForTests();
  });

  it("layers changed, added and deleted blocks over local production, fetching only the manifest and changed blobs", async () => {
    const { cms, prepare, manifestOf, pointerFor, requested } = await setup();
    const v1 = await prepare("draft1");
    const m1 = manifestOf(v1);
    expect(Object.keys(m1.set).sort()).toEqual(["Banner", "Hero", "New"]);
    expect(m1.delete).toEqual(["Promo"]);

    const draft = cms.forDraft(pointerFor(v1));
    expect(await draft.resolve("Hero")).toEqual([
      { title: "draft hero" },
      null,
    ]);
    expect(await draft.resolve("New")).toEqual([{ title: "new block" }, null]);
    // Untouched: inherited from the site's production, not the merge base.
    expect(await draft.resolve("Footer")).toEqual([
      { title: "footer in production" },
      null,
    ]);
    const [posts, listError] = await draft.list<{ title: string }>("post");
    expect(listError).toBeNull();
    expect(posts!.map((p) => p.title).sort()).toEqual([
      "draft hero",
      "footer in production",
      "new block",
    ]);
    expect(await draft.revision()).toBe(`prod-1~${v1}`);

    expect(requested).toHaveLength(4);
    expect(requested[0]).toBe(manifestPath(v1));
    expect(requested.slice(1).sort()).toEqual(
      Object.values(m1.set).map(blockPath).sort(),
    );

    // Published content is untouched by the draft. (forRevision, not
    // forRelease: a release client starts a background channel check.)
    expect(await cms.forRevision("prod-1").resolve("Promo")).toEqual([
      { title: "published promo" },
      null,
    ]);
  });

  it("reuses cached blobs for a second overlay version: only its manifest and new blobs download", async () => {
    const { cms, prepare, manifestOf, pointerFor, requested } = await setup();
    const v1 = await prepare("draft1");
    await cms.forDraft(pointerFor(v1)).resolve("Hero");
    const v2 = await prepare("draft2");
    expect(v2).not.toBe(v1);
    const m2 = manifestOf(v2);
    requested.length = 0;

    const draft = cms.forDraft(pointerFor(v2));
    expect(await draft.resolve("Footer")).toEqual([
      { title: "draft footer" },
      null,
    ]);
    expect(await draft.resolve("Hero")).toEqual([
      { title: "draft hero" },
      null,
    ]);
    expect(requested).toEqual([manifestPath(v2), blockPath(m2.set.Footer!)]);
  });

  it("never serves a blob outside the authorized manifest", async () => {
    const { app, prepare, manifestOf } = await setup();
    const v1 = await prepare("draft1");
    const v2 = await prepare("draft2");
    const footer2 = manifestOf(v2).set.Footer!;
    expect(Object.values(manifestOf(v1).set)).not.toContain(footer2);

    // The blob exists, but v1's grant doesn't cover it.
    const grant1 = signOverlayGrant({ site: SITE, version: v1 }).token;
    const res = await app.request(
      `/sites/${SITE}/draft-blocks/${footer2}.json?token=${grant1}`,
      { headers: { authorization: `Bearer ${siteToken(SITE)}` } },
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("no-store");

    // And v2's grant does.
    const grant2 = signOverlayGrant({ site: SITE, version: v2 }).token;
    const ok = await app.request(
      `/sites/${SITE}/draft-blocks/${footer2}.json?token=${grant2}`,
      { headers: { authorization: `Bearer ${siteToken(SITE)}` } },
    );
    expect(ok.status).toBe(200);
  });

  it("errors on an overlay that doesn't exist, never showing published content", async () => {
    const { cms, pointerFor, requested } = await setup();
    const missing = "1".repeat(64);
    const draft = cms.forDraft(pointerFor(missing));
    const [value, error] = await draft.resolve("Hero");
    expect(value).toBeNull();
    expect(error?.code).toBe("LOADER_FAILED");
    expect((await draft.list("post"))[1]?.code).toBe("LOADER_FAILED");
    expect(requested).toEqual([manifestPath(missing)]);
  });

  it("applies a forced __variant on top of the overlay", async () => {
    const { cms, prepare, pointerFor, requested } = await setup();
    const v1 = await prepare("draft1");
    const pointer = pointerFor(v1);
    const parsed = parseDraftPointer(pointer)!;
    const forced = (index: number) =>
      formatDraftPointer({
        ...parsed,
        variants: [{ block: "Banner", path: "", index }],
      });

    expect(await cms.forDraft(forced(1)).resolve("Banner")).toEqual([
      "draft summer",
      null,
    ]);
    expect(await cms.forDraft(forced(0)).resolve("Banner")).toEqual([
      "draft fallback",
      null,
    ]);
    // Variants of one draft share one load: one manifest download.
    expect(requested.filter((r) => r === manifestPath(v1))).toHaveLength(1);
  });
});
