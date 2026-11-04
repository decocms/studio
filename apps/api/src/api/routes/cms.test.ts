/**
 * Route tests of the hosted CMS API (`cms.ts`): today's gates in order,
 * `via` from the auth method, draft names with `/`, schema push and the
 * blocksMajor marker. Buckets and the drafts table are in memory.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { clearRevisionCache } from "@/hosted/cms-release";
import { clearSchemaCache } from "@/hosted/cms-storage";
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

  it("404 site_not_found for a site of another org or none", async () => {
    const t = cmsTestApp({ sites: { acme: "org_1", other: "org_2" } });
    expect((await t.call("GET", "other/drafts")).body.code).toBe(
      "site_not_found",
    );
    expect((await t.call("GET", "nope/drafts")).status).toBe(404);
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
    expect(created.body.pointer).toBe(
      `delivery.decocms.com/sites/acme/drafts/${created.body.slug}.json@${created.body.etag}`,
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

describe("releases and rollback", () => {
  it("refuses a malformed revision id or cursor", async () => {
    const t = cmsTestApp();
    expect(
      (await t.call("POST", "acme/releases/abc/rollback", {})).body.code,
    ).toBe("revision_not_found");
    expect((await t.call("GET", "acme/releases?cursor=zzz")).status).toBe(400);
  });
});
