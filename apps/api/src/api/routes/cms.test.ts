/**
 * Route tests of the hosted CMS API (`cms.ts`): today's gates in order,
 * `via` from the auth method, draft names with `/`, schema push and the
 * blocksMajor marker. Buckets and the drafts table are in memory.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { clearRevisionCache } from "@/hosted/cms-release";
import { clearSchemaCache } from "@/hosted/cms-storage";
import { seedRelease } from "@/hosted/cms-test-helpers";
import {
  DeliveryUnavailableError,
  deliveryKeys,
} from "@/hosted/delivery-store";
import { newRevisionId } from "@/hosted/revision-id";
import { SCHEMA_TEXT } from "@/hosted/hosted-test-helpers";
import { cmsTestApp } from "./cms-test-app";

beforeEach(() => {
  clearRevisionCache();
  clearSchemaCache();
});

describe("gates, in today's order", () => {
  it("401 for no caller, before the plan gate", async () => {
    const t = cmsTestApp({ hasCms: false });
    t.as({ userId: null });
    expect((await t.call("GET", "acme/drafts")).status).toBe(401);
  });

  it("403 feature_not_in_plan without the cms plan", async () => {
    const t = cmsTestApp({ hasCms: false });
    const res = await t.call("GET", "acme/drafts");
    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      error: "This organization's plan does not include the CMS",
      code: "feature_not_in_plan",
    });
  });

  it("404 site_not_found, the same answer, for an unknown site and one of an org the caller isn't in", async () => {
    const t = cmsTestApp({ sites: { acme: "org_1", other: "org_2" } });
    const other = await t.call("GET", "other/drafts");
    const none = await t.call("GET", "nope/drafts");
    expect(other.status).toBe(404);
    expect(none.status).toBe(404);
    expect(other.body).toEqual({
      error: "Site not found",
      code: "site_not_found",
    });
    expect(none.body).toEqual(other.body);
    // Not even the plan gate tells them apart.
    const noPlan = cmsTestApp({ hasCms: false, sites: { other: "org_2" } });
    expect((await noPlan.call("GET", "other/drafts")).body).toEqual(other.body);
  });

  it("the path names no org: the site's org is resolved from org_sites", async () => {
    const t = cmsTestApp({ sites: { acme: "org_1", other: "org_2" } });
    t.as({ userId: "usr_ana", method: "session", orgs: ["org_2"] });
    expect((await t.call("GET", "other/drafts")).status).toBe(200);
    expect((await t.call("GET", "acme/drafts")).status).toBe(404);
  });

  it("403 org_blocked for a blocked org's writes; its reads still answer", async () => {
    const t = cmsTestApp({ blocked: ["org_1"] });
    expect((await t.call("GET", "acme/drafts")).status).toBe(200);
    const res = await t.call("POST", "acme/drafts", { name: "x" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("org_blocked");
  });

  it("503 when the delivery bucket isn't configured, after the site check", async () => {
    const t = cmsTestApp({ configured: false });
    expect((await t.call("GET", "nope/drafts")).status).toBe(404);
    const res = await t.call("GET", "acme/drafts");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("hosted_delivery_unconfigured");
  });
});

describe("drafts", () => {
  it("creates idempotently, records via from the auth method, and resolves names with /", async () => {
    const t = cmsTestApp();
    t.as({ userId: "usr_ana", method: "mcpOAuth" });
    const created = await t.call("POST", "acme/drafts", {
      name: "threads/t-1",
      via: "studio",
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      name: "threads/t-1",
      createdBy: "usr_ana",
      via: "cli",
      created: true,
    });
    // The draft index's key, at the draft token (22 base64url characters).
    expect(created.body.pointer).toMatch(
      new RegExp(
        `^delivery\\.decocms\\.com/sites/acme/drafts/${created.body.slug}/index\\.json@[A-Za-z0-9_-]{22}$`,
      ),
    );
    expect(created.body.previewUrl).toBe(
      `https://preview.acme.com/?__draft=${encodeURIComponent(created.body.pointer)}`,
    );
    t.as({ userId: "usr_bob", method: "apiKey" });
    const again = await t.call("POST", "acme/drafts", { name: "threads/t-1" });
    expect(again.body).toMatchObject({
      slug: created.body.slug,
      created: false,
      via: "cli",
    });
    const resolved = await t.call(
      "GET",
      `acme/drafts/${encodeURIComponent("threads/t-1")}`,
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.slug).toBe(created.body.slug);
    const list = await t.call("GET", "acme/drafts");
    expect(list.body.drafts.map((d: { name: string }) => d.name)).toEqual([
      "threads/t-1",
    ]);
  });

  it.each([
    [{ method: "session" as const }, "studio"],
    [{ method: "mcpOAuth" as const }, "cli"],
    [{ method: "apiKey" as const }, "token"],
    [{ method: "apiKey" as const, onBehalfOf: true }, "studio-agent"],
    [{ method: "studioJwt" as const }, "studio-agent"],
  ])("via for %j is %s", async (auth, via) => {
    const t = cmsTestApp();
    t.as({ userId: "u", ...auth });
    expect((await t.call("POST", "acme/drafts", { name: "d" })).body.via).toBe(
      via,
    );
  });

  it("refuses a bad name, and answers 404 for a draft that doesn't exist", async () => {
    const t = cmsTestApp();
    expect(
      (await t.call("POST", "acme/drafts", { name: "../x" })).body.code,
    ).toBe("invalid_draft_name");
    expect((await t.call("GET", "acme/drafts/missing")).body.code).toBe(
      "draft_not_found",
    );
    expect((await t.rpc("acme", "missing", "blocks.list")).status).toBe(404);
    expect(
      (await t.call("POST", "acme/drafts/missing/publish", {})).status,
    ).toBe(404);
    expect((await t.call("DELETE", "acme/drafts/missing")).status).toBe(404);
  });

  it("refuses a save without a precondition for every block it touches", async () => {
    const t = cmsTestApp();
    await t.call("POST", "acme/drafts", { name: "d" });
    const res = await t.rpc("acme", "d", "blocks.apply", { set: { a: {} } });
    expect(res.body.error.code).toBe(-32602);
  });
});

describe("rpc: cms.index and cms.blocks", () => {
  it("answers Studio's methods with the protocol's, in one batch, in order", async () => {
    const t = cmsTestApp();
    await t.call("POST", "acme/drafts", { name: "d" });
    const saved = await t.rpc("acme", "d", "blocks.apply", {
      set: { home: { __resolveType: "website/pages/Page.tsx", path: "/" } },
      ifMatch: { home: null },
    });
    expect(saved.body.error).toBeUndefined();
    const res = await t.call("POST", "acme/drafts/d/rpc", [
      { jsonrpc: "2.0", id: 1, method: "cms.index", params: {} },
      { jsonrpc: "2.0", id: 2, method: "schema.get", params: {} },
      { jsonrpc: "2.0", id: 3, method: "changes.list", params: {} },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "cms.blocks",
        params: { names: ["home", "x"] },
      },
    ]);
    expect(res.status).toBe(200);
    expect(res.body.map((a: { id: number }) => a.id)).toEqual([1, 2, 3, 4]);
    expect(res.body[0].result.entries.home.meta).toEqual({
      type: "website/pages/Page.tsx",
      path: "/",
    });
    expect(res.body[0].result.draft.home.editor.userId).toBeDefined();
    expect(Object.keys(res.body[2].result.changes)).toEqual(["home"]);
    expect(res.body[3].result).toMatchObject({
      blocks: { home: { __resolveType: "website/pages/Page.tsx", path: "/" } },
      missing: ["x"],
    });
    const again = await t.rpc("acme", "d", "cms.index", {
      ifNoneMatch: res.body[0].result.revision,
    });
    expect(again.body.result).toEqual({
      notModified: true,
      revision: res.body[0].result.revision,
    });
    // The draft resource's pointer carries the same token.
    const draft = await t.call("GET", "acme/drafts/d");
    expect(draft.body.pointer.endsWith(`@${res.body[0].result.revision}`)).toBe(
      true,
    );
  });
});

describe("schema push", () => {
  it("writes schema.json and sets the v8 marker from it", async () => {
    const t = cmsTestApp();
    const res = await t.call("PUT", "acme/schema", undefined, SCHEMA_TEXT);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ etag: "schema1", blocksMajor: 8 });
    expect(t.records.objects.get("acme")?.text).toBe(SCHEMA_TEXT);
    expect(t.patches).toEqual([{ set: { blocksMajor: 8 }, unset: [] }]);
    // The editor's forms read it back through the protocol.
    await t.call("POST", "acme/drafts", { name: "d" });
    const schema = await t.rpc("acme", "d", "schema.get");
    expect(schema.body.result.schema).toEqual(JSON.parse(SCHEMA_TEXT));
  });

  it("refuses a body that isn't a JSON object", async () => {
    const t = cmsTestApp();
    expect(
      (await t.call("PUT", "acme/schema", undefined, "[1]")).body.code,
    ).toBe("invalid_body");
    expect((await t.call("PUT", "acme/schema", undefined, "nope")).status).toBe(
      400,
    );
  });
});

describe("codes for the other failures (§4.3)", () => {
  it("500 malformed for a delivery object this Studio didn't write", async () => {
    const t = cmsTestApp();
    t.delivery.objects.set("sites/acme/latest.json", {
      text: "{not json",
      etag: '"x"',
      cacheControl: "",
    });
    const res = await t.call("GET", "acme/releases");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: "sites/acme/latest.json is malformed",
      code: "malformed",
    });
  });

  it("503 hosted_delivery_unconfigured when site tokens aren't configured", async () => {
    const t = cmsTestApp();
    for (const method of ["GET", "POST"]) {
      const res = await t.call(method, "acme/site-tokens");
      expect(res.status).toBe(503);
      expect(res.body.code).toBe("hosted_delivery_unconfigured");
    }
  });
});

describe("releases and rollback", () => {
  it("refuses a malformed revision id or cursor", async () => {
    const t = cmsTestApp();
    expect(
      (await t.call("POST", "acme/releases/abc/rollback", {})).body.code,
    ).toBe("revision_not_found");
    expect((await t.call("GET", "acme/releases?cursor=zzz")).status).toBe(400);
  });

  it("an unparseable meta.json is a broken row; a rollback to it is 500 malformed, past it works", async () => {
    const t = cmsTestApp();
    const [r1, r2, r3] = [1, 2, 3].map((n) =>
      newRevisionId(Date.parse("2026-11-01T00:00:00.000Z") + n),
    ) as [string, string, string];
    for (const id of [r1, r2, r3])
      await seedRelease(t.delivery.store, "acme", id, { a: { id } });
    t.delivery.objects.set(deliveryKeys.revisionMeta("acme", r2), {
      text: "{nope",
      etag: '"x"',
      cacheControl: "",
    });
    const res = await t.call("GET", "acme/releases");
    expect(res.status).toBe(200);
    expect(res.body.revisions).toEqual([
      expect.objectContaining({ id: r3, status: "current" }),
      { id: r2, status: "unreadable" },
      expect.objectContaining({ id: r1, status: "listed" }),
    ]);
    const broken = await t.call("POST", `acme/releases/${r2}/rollback`, {});
    expect(broken.status).toBe(500);
    expect(broken.body.code).toBe("malformed");
    const rolled = await t.call("POST", `acme/releases/${r1}/rollback`, {});
    expect(rolled.status).toBe(200);
    expect(rolled.body).toMatchObject({ result: "published", previous: r3 });
  });

  it("409 not_published for a rollback before the site's first publish", async () => {
    const t = cmsTestApp();
    const r1 = newRevisionId(Date.parse("2026-11-01T00:00:00.000Z"));
    await seedRelease(t.delivery.store, "acme", r1, { a: {} });
    t.delivery.objects.delete(deliveryKeys.latest("acme"));
    const res = await t.call("POST", `acme/releases/${r1}/rollback`, {});
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: "The site has no published release yet; publish a draft first",
      code: "not_published",
    });
    expect(t.delivery.objects.has(deliveryKeys.latest("acme"))).toBe(false);
  });

  it("a meta.json GET failing (R2 5xx) is 503 unavailable, not a broken row", async () => {
    const t = cmsTestApp();
    const r1 = newRevisionId(Date.parse("2026-11-01T00:00:00.000Z"));
    await seedRelease(t.delivery.store, "acme", r1, { a: {} });
    const key = deliveryKeys.revisionMeta("acme", r1);
    const get = t.delivery.store.get.bind(t.delivery.store);
    t.delivery.store.get = (async (k: string, options?: unknown) => {
      if (k === key) throw new DeliveryUnavailableError(k, new Error("503"));
      return (get as (k: string, o?: unknown) => ReturnType<typeof get>)(
        k,
        options,
      );
    }) as typeof t.delivery.store.get;
    const res = await t.call("GET", "acme/releases");
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("unavailable");
  });
});
