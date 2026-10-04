import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { remoteLoader, resetForTests } from "@decocms/blocks";
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

const block = (value: unknown) => serializeBlock(value);

/** Production at the merge base, and a draft that edits Hero and deletes Promo. */
async function prepared() {
  const { client } = fakeRepo({
    mergeBase: "base",
    commits: {
      base: {
        "Hero.json": block({ title: "published" }),
        "Promo.json": block({ on: true }),
        "Footer.json": block({ links: 1 }),
      },
      draft: {
        "Hero.json": block({ title: "draft" }),
        "Footer.json": block({ links: 1 }),
      },
    },
  });
  const { store, objects } = memoryStorage();
  const version = await prepareDraftOverlay(
    { client, packagePath: null, site: "acme", revision: "draft" },
    store,
  );
  const manifest = JSON.parse(
    objects.get(deliveryKeys.manifest("acme", version))!,
  ) as { set: Record<string, string> };
  const app = createDraftDeliveryRoutes(() => store);
  return { app, store, objects, version, heroHash: manifest.set.Hero! };
}

const auth = (site = "acme") => ({
  authorization: `Bearer ${siteToken(site)}`,
});

describe("draft delivery routes", () => {
  it("serves the granted manifest until its grant expires, and its blocks immutably", async () => {
    const { app, version, heroHash } = await prepared();
    // Signed 20 minutes ago: 40 of its 60 minutes are left.
    const { token } = signOverlayGrant({
      site: "acme",
      version,
      nowMs: Date.now() - 20 * 60_000,
    });

    const manifest = await app.request(
      `/sites/acme/drafts/${version}.json?token=${token}`,
      { headers: auth() },
    );
    expect(manifest.status).toBe(200);
    const maxAge = Number(
      /^private, max-age=(\d+)$/.exec(
        manifest.headers.get("cache-control") ?? "",
      )?.[1],
    );
    expect(maxAge).toBeGreaterThan(40 * 60 - 5);
    expect(maxAge).toBeLessThanOrEqual(40 * 60);
    expect(await manifest.json()).toEqual({
      format: 1,
      set: { Hero: heroHash },
      delete: ["Promo"],
    });

    const hero = await app.request(
      `/sites/acme/draft-blocks/${heroHash}.json?token=${token}`,
      { headers: auth() },
    );
    expect(hero.status).toBe(200);
    expect(hero.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    expect(await hero.json()).toEqual({ title: "draft" });
  });

  it("requires the site's own token", async () => {
    const { app, version } = await prepared();
    const { token } = signOverlayGrant({ site: "acme", version });
    const path = `/sites/acme/drafts/${version}.json?token=${token}`;
    expect((await app.request(path)).status).toBe(401);
    const wrong = await app.request(path, { headers: auth("other") });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("cache-control")).toBe("no-store");
  });

  it("requires a grant for this site and this overlay version", async () => {
    const { app, version } = await prepared();
    const other = signOverlayGrant({ site: "other", version }).token;
    const older = signOverlayGrant({ site: "acme", version: "0".repeat(64) });
    const expired = signOverlayGrant({
      site: "acme",
      version,
      nowMs: Date.now() - 7 * 60 * 60 * 1000,
    }).token;
    for (const token of ["", other, older.token, expired, "garbage"]) {
      const res = await app.request(
        `/sites/acme/drafts/${version}.json?token=${token}`,
        { headers: auth() },
      );
      expect(res.status).toBe(403);
    }
  });

  it("serves a block only when the granted manifest lists its hash", async () => {
    const { app, store, version } = await prepared();
    // A block stored under this site but outside the granted overlay.
    const stray = "e".repeat(64);
    await store.put(deliveryKeys.block("acme", stray), "{}");
    const { token } = signOverlayGrant({ site: "acme", version });
    const res = await app.request(
      `/sites/acme/draft-blocks/${stray}.json?token=${token}`,
      { headers: auth() },
    );
    expect(res.status).toBe(403);
  });

  it("404s an overlay that isn't prepared yet, uncached", async () => {
    const { app } = await prepared();
    const missing = "1".repeat(64);
    const { token } = signOverlayGrant({ site: "acme", version: missing });
    const res = await app.request(
      `/sites/acme/drafts/${missing}.json?token=${token}`,
      { headers: auth() },
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("404s names that aren't assets or sites", async () => {
    const { app, version } = await prepared();
    const { token } = signOverlayGrant({ site: "acme", version });
    for (const path of [
      `/sites/acme/drafts/${version}?token=${token}`,
      `/sites/acme/drafts/../x.json?token=${token}`,
      `/sites/ACME/drafts/${version}.json?token=${token}`,
    ]) {
      expect((await app.request(path, { headers: auth() })).status).toBe(404);
    }
  });
});

describe("cms.forDraft over the delivery routes", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetForTests();
  });

  it("layers the overlay over the site's own production content", async () => {
    const { app, version } = await prepared();
    const requested: string[] = [];
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(input instanceof Request ? input.url : input);
      expect(url.host).toBe("delivery.decocms.com");
      requested.push(url.pathname);
      return app.request(`${url.pathname}${url.search}`, init);
    }) as typeof fetch;

    const production = {
      revision: "prod-1",
      blocks: {
        Hero: { title: "published" },
        Promo: { on: true },
        Footer: { links: 2 },
      },
    };
    const loader = remoteLoader(production, {
      site: "acme",
      token: siteToken("acme"),
    });
    const { token } = signOverlayGrant({ site: "acme", version });
    const draft = await loader.load(
      draftOverlayPointer({ site: "acme", version, grant: token }),
    );

    expect(draft.blocks).toEqual({
      Hero: { title: "draft" },
      // Production's newer Footer is inherited, not the draft's stale copy.
      Footer: { links: 2 },
    });
    expect(draft.revision).toBe(`prod-1~${version}`);
    expect(requested).toEqual([
      `/sites/acme/drafts/${version}.json`,
      expect.stringMatching(
        /^\/sites\/acme\/draft-blocks\/[0-9a-f]{64}\.json$/,
      ),
    ]);
  });

  it("fails the draft, never falling back to published content", async () => {
    const { app, version } = await prepared();
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return app.request(`${url.pathname}${url.search}`, init);
    }) as typeof fetch;
    const loader = remoteLoader(
      { revision: "prod-1", blocks: { Hero: { title: "published" } } },
      { site: "acme", token: "not-the-site-token" },
    );
    const { token } = signOverlayGrant({ site: "acme", version });
    await expect(
      loader.load(draftOverlayPointer({ site: "acme", version, grant: token })),
    ).rejects.toThrow(/401/);
  });
});
