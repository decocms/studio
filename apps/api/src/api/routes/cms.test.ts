/**
 * Route tests of the hosted CMS API (`cms.ts`): today's gates in order,
 * `via` from the auth method, draft names with `/`, and schema push, which
 * only a project with the "Blocks v8 site" switch on takes and which never
 * writes the switch. Buckets and the drafts table are in memory.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { clearRevisionCache } from "@/hosted/cms-release";
import { clearSchemaCache } from "@/hosted/cms-storage";
import { seedRelease } from "@/hosted/cms-test-helpers";
import {
  DeliveryUnavailableError,
  deliveryKeys,
} from "@/hosted/delivery-store";
import { newRevisionId } from "@/hosted/revision-id";
import { createSiteTokens, importSigningKey } from "@/hosted/site-token";
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

  describe("403 project_not_allowed for a caller scoped to other projects", () => {
    const sites = { acme: "org_1", beta: "org_1" };
    const siteProjects = { acme: "p1", beta: "p2" };

    it("a credential scoped to its own project reaches that project's site only", async () => {
      const t = cmsTestApp({ sites, siteProjects });
      t.as({
        userId: "usr_ana",
        method: "studioJwt",
        role: "editor",
        permissions: { projects: ["p1"] },
      });
      expect((await t.call("GET", "acme/drafts")).status).toBe(200);
      const other = await t.call("GET", "beta/drafts");
      expect(other.status).toBe(403);
      expect(other.body).toEqual({
        error: "This site's project is outside your access",
        code: "project_not_allowed",
      });
      // Writes are refused the same way, before anything is stored.
      const write = await t.call("PUT", "beta/schema", undefined, SCHEMA_TEXT);
      expect(write.status).toBe(403);
      expect(t.delivery.objects.has("sites/beta/schema.json")).toBe(false);
    });

    it("a member of a role scoped to other projects is refused (session)", async () => {
      const t = cmsTestApp({ sites, siteProjects });
      t.as({
        userId: "usr_ana",
        method: "session",
        role: "editor",
        permissions: { projects: ["*", "!p2"] },
      });
      expect((await t.call("GET", "acme/drafts")).status).toBe(200);
      expect((await t.call("GET", "beta/drafts")).status).toBe(403);
    });

    it("an org-wide credential reaches every project's site", async () => {
      const t = cmsTestApp({ sites, siteProjects });
      t.as({
        userId: "usr_ana",
        method: "studioJwt",
        role: "editor",
        permissions: { "*": ["*"] },
      });
      expect((await t.call("GET", "acme/drafts")).status).toBe(200);
      expect((await t.call("GET", "beta/drafts")).status).toBe(200);
    });

    it("an API key is authorized by its own allowlist, not a project scope", async () => {
      const t = cmsTestApp({ sites, siteProjects });
      t.as({
        userId: "usr_ana",
        method: "apiKey",
        apiKey: true,
        role: "editor",
        permissions: { "*": ["*"] },
      });
      expect((await t.call("GET", "acme/drafts")).status).toBe(200);
      expect((await t.call("GET", "beta/drafts")).status).toBe(200);
    });

    it("a Studio session of an unscoped member or an admin is unaffected", async () => {
      const t = cmsTestApp({ sites, siteProjects });
      t.as({ userId: "usr_ana", method: "session", role: "user" });
      expect((await t.call("GET", "beta/drafts")).status).toBe(200);
      t.as({
        userId: "usr_ana",
        method: "session",
        role: "admin",
        permissions: { projects: ["p1"] },
      });
      expect((await t.call("GET", "beta/drafts")).status).toBe(200);
    });

    it("the scope check comes after the site check (no existence leak)", async () => {
      const t = cmsTestApp({
        sites: { ...sites, other: "org_2" },
        siteProjects: { ...siteProjects, other: "p9" },
      });
      t.as({
        userId: "usr_ana",
        method: "session",
        role: "editor",
        permissions: { projects: ["p1"] },
      });
      expect((await t.call("GET", "other/drafts")).status).toBe(404);
      expect((await t.call("GET", "nope/drafts")).status).toBe(404);
    });
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
  it("writes schema.json on a Blocks v8 site, and never the switch", async () => {
    const t = cmsTestApp();
    const res = await t.call("PUT", "acme/schema", undefined, SCHEMA_TEXT);
    expect(res.status).toBe(200);
    // In the delivery bucket, next to the site's releases.
    const stored = t.delivery.objects.get("sites/acme/schema.json");
    expect(stored?.text).toBe(SCHEMA_TEXT);
    expect(stored?.cacheControl).toBe("no-cache, max-age=0, must-revalidate");
    expect(res.body).toEqual({
      etag: stored?.etag.replaceAll('"', ""),
      blocksMajor: 8,
    });
    expect(t.patches).toEqual([]);
    // The editor's forms read it back through the protocol.
    await t.call("POST", "acme/drafts", { name: "d" });
    const schema = await t.rpc("acme", "d", "schema.get");
    expect(schema.body.result.schema).toEqual(JSON.parse(SCHEMA_TEXT));
  });

  it("a v7 schema on a Blocks v8 site is stored, and the switch stays on", async () => {
    const t = cmsTestApp();
    const v7 = JSON.stringify({ definitions: {}, root: {} });
    const res = await t.call("PUT", "acme/schema", undefined, v7);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ blocksMajor: null });
    expect(t.patches).toEqual([]);
  });

  it("is refused while the project's Blocks v8 site switch is off", async () => {
    const t = cmsTestApp({ blocksV8: false });
    const res = await t.call("PUT", "acme/schema", undefined, SCHEMA_TEXT);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not_blocks_v8_site");
    expect(res.body.error).toContain('"Blocks v8 site"');
    // Nothing is stored, and the switch is not turned on.
    expect(t.delivery.objects.has("sites/acme/schema.json")).toBe(false);
    expect(t.patches).toEqual([]);
  });

  it("is refused for a site no project is linked to", async () => {
    const t = cmsTestApp({ siteProjects: {} });
    const res = await t.call("PUT", "acme/schema", undefined, SCHEMA_TEXT);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("not_blocks_v8_site");
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

describe("schema push with a site token", () => {
  async function signingKey() {
    const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    return Buffer.from(
      await crypto.subtle.exportKey("pkcs8", pair.privateKey),
    ).toString("base64");
  }

  /** A site token issued through the route, then the caller is only it. */
  async function setup(options: Parameters<typeof cmsTestApp>[0] = {}) {
    const key = await signingKey();
    const t = cmsTestApp({
      sites: { acme: "org_1", beta: "org_1" },
      siteProjects: { acme: "p1", beta: "p1" },
      ...options,
      siteTokenSigningKey: key,
    });
    // Issues into the app's KV, then calls as the token alone.
    const issue = async (site: string, organizationId = "org_1") => {
      const issued = await createSiteTokens({
        kv: t.kv,
        signingKey: () => importSigningKey(key),
      }).issue(organizationId, site);
      t.as({ userId: null });
      return issued;
    };
    const push = (site: string, token: string) =>
      t.call("PUT", `${site}/schema`, undefined, SCHEMA_TEXT, token);
    return { t, key, issue, push };
  }

  const INVALID = { error: "Invalid site token", code: "invalid_site_token" };

  it("pushes with the site's token, logged as via site-token with the kid", async () => {
    const { t, issue, push } = await setup();
    const { token, record } = await issue("acme");
    const info = spyOn(console, "info").mockImplementation(() => {});
    try {
      const res = await push("acme", token);
      expect(res.status).toBe(200);
      expect(res.body.blocksMajor).toBe(8);
      expect(t.delivery.objects.get("sites/acme/schema.json")?.text).toBe(
        SCHEMA_TEXT,
      );
      expect(info).toHaveBeenCalledWith("cms: schema pushed", {
        site: "acme",
        organizationId: "org_1",
        etag: res.body.etag,
        via: "site-token",
        kid: record.kid,
      });
    } finally {
      info.mockRestore();
    }
  });

  it("401s a token of another site with the same answer as an unknown site", async () => {
    const { t, issue, push } = await setup();
    const { token } = await issue("beta");
    const other = await push("acme", token);
    const unknown = await push("nope", token);
    expect(other.status).toBe(401);
    expect(other.body).toEqual(INVALID);
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(other.body);
    expect(t.delivery.objects.has("sites/acme/schema.json")).toBe(false);
  });

  it("401s a revoked token; revoking is a user route and answers 404 the second time", async () => {
    const { t, issue, push } = await setup();
    const { token, record } = await issue("acme");
    const kept = await issue("acme");
    // A site token can't revoke, even its own.
    expect(
      (
        await t.call(
          "DELETE",
          `acme/site-tokens/${record.kid}`,
          undefined,
          undefined,
          token,
        )
      ).status,
    ).toBe(401);
    t.as({ userId: "usr_ana", method: "session" });
    const revoked = await t.call("DELETE", `acme/site-tokens/${record.kid}`);
    expect(revoked).toEqual({ status: 200, body: { revoked: true } });
    const again = await t.call("DELETE", `acme/site-tokens/${record.kid}`);
    expect(again.status).toBe(404);
    expect(again.body.code).toBe("site_token_not_found");
    const listed = await t.call("GET", "acme/site-tokens");
    expect(listed.body.tokens).toEqual([kept.record]);
    t.as({ userId: null });
    const res = await push("acme", token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual(INVALID);
    expect((await push("acme", kept.token)).status).toBe(200);
  });

  it("401s a kid the site never issued, even with a valid signature", async () => {
    const { issue, push } = await setup();
    // Signed with Studio's key, but recorded in another org's KV.
    const { token } = await issue("acme", "org_2");
    expect((await push("acme", token)).body).toEqual(INVALID);
  });

  it("401s a bad signature, a tampered payload, and a token that isn't one", async () => {
    const { issue, push } = await setup();
    const { token } = await issue("acme");
    const [h, p, sig] = token.split(".") as [string, string, string];
    const foreign = await setup();
    const { token: foreignToken } = await foreign.issue("acme");
    const tampered = `${h}.${Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(p, "base64url").toString()),
        iat: 1,
      }),
    ).toString("base64url")}.${sig}`;
    for (const bad of [
      foreignToken,
      tampered,
      `${h}.${p}.${sig.slice(0, 10)}${sig[10] === "A" ? "B" : "A"}${sig.slice(11)}`,
      "not-a-token",
      `${h}.${p}`,
    ]) {
      const res = await push("acme", bad);
      expect({ bad, status: res.status }).toEqual({ bad, status: 401 });
    }
  });

  it("401s a site token on every other route", async () => {
    const { t, issue } = await setup();
    const { token } = await issue("acme");
    const r = newRevisionId(Date.parse("2026-11-01T00:00:00.000Z"));
    await seedRelease(t.delivery.store, "acme", r, { a: { id: "a" } });
    for (const [method, path, body] of [
      ["GET", "acme/drafts"],
      ["POST", "acme/drafts", { name: "d" }],
      ["GET", "acme/drafts/d"],
      ["DELETE", "acme/drafts/d"],
      ["POST", "acme/drafts/d/rpc", { jsonrpc: "2.0", id: 1, method: "x" }],
      ["POST", "acme/drafts/d/publish", {}],
      ["PUT", "acme/drafts/schema/schema", {}],
      ["GET", "acme/releases"],
      ["POST", `acme/releases/${r}/rollback`, {}],
      ["GET", "acme/site-tokens"],
      ["POST", "acme/site-tokens"],
      ["GET", "acme/schema"],
    ] as Array<[string, string, unknown?]>) {
      const res = await t.call(method, path, body, undefined, token);
      expect({ method, path, status: res.status }).toEqual({
        method,
        path,
        status: 401,
      });
    }
    expect(t.table.rows.size).toBe(0);
  });

  it("keeps the other checks: v8 switch, size, blocked org, plan; an archived org is refused", async () => {
    const off = await setup({ blocksV8: false });
    const offRes = await off.push("acme", (await off.issue("acme")).token);
    expect(offRes.status).toBe(409);
    expect(offRes.body.code).toBe("not_blocks_v8_site");

    const big = await setup();
    const bigToken = (await big.issue("acme")).token;
    const huge = `{"x":"${"a".repeat(16 * 1024 * 1024)}"}`;
    expect(
      (await big.t.call("PUT", "acme/schema", undefined, huge, bigToken))
        .status,
    ).toBe(413);

    const blocked = await setup({ blocked: ["org_1"] });
    const blockedToken = (await blocked.issue("acme")).token;
    const blockedRes = await blocked.push("acme", blockedToken);
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.body.code).toBe("org_blocked");

    const noPlan = await setup({ hasCms: false });
    const noPlanRes = await noPlan.push(
      "acme",
      (await noPlan.issue("acme")).token,
    );
    expect(noPlanRes.status).toBe(403);
    expect(noPlanRes.body.code).toBe("feature_not_in_plan");

    const archived = await setup({ archived: ["org_1"] });
    const archivedToken = (await archived.issue("acme")).token;
    const archivedRes = await archived.push("acme", archivedToken);
    expect(archivedRes.status).toBe(401);
    expect(archivedRes.body).toEqual(INVALID);
    expect(archived.t.delivery.objects.has("sites/acme/schema.json")).toBe(
      false,
    );
  });

  it("401s without a bearer, as before", async () => {
    const { t } = await setup();
    t.as({ userId: null });
    const res = await t.call("PUT", "acme/schema", undefined, SCHEMA_TEXT);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });
});

describe("codes for the other failures (§4.3)", () => {
  it("500 malformed for a delivery object this Studio didn't write", async () => {
    const t = cmsTestApp();
    const [r1, r2] = [1, 2].map((n) =>
      newRevisionId(Date.parse("2026-11-01T00:00:00.000Z") + n),
    ) as [string, string];
    for (const id of [r1, r2])
      await seedRelease(t.delivery.store, "acme", id, { a: { id } });
    // An index the valid latest.json's history names: real corruption.
    t.delivery.objects.set(deliveryKeys.revisionIndex("acme", r1), {
      text: "{not json",
      etag: '"x"',
      cacheControl: "",
    });
    const res = await t.call("POST", `acme/releases/${r1}/rollback`, {});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: `sites/acme/revisions/${r1}/index.json is malformed`,
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

describe("a malformed latest.json is no release yet", () => {
  /** latest.json from before content-addressed revisions (a 40-hex SHA). */
  function malformed(t: ReturnType<typeof cmsTestApp>) {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    t.delivery.objects.set(`sites/acme/revisions/${sha}.json`, {
      text: '{"home":{}}',
      etag: '"sha"',
      cacheControl: "",
    });
    t.delivery.objects.set(deliveryKeys.latest("acme"), {
      text: JSON.stringify({ revision: sha, sequence: 3, blocks: {} }),
      etag: '"old"',
      cacheControl: "",
    });
  }

  /** A save, then cms.index and the draft's pointer token. */
  async function saveAndRead(t: ReturnType<typeof cmsTestApp>) {
    await t.call("POST", "acme/drafts", { name: "d" });
    const saved = await t.rpc("acme", "d", "blocks.apply", {
      set: { home: { __resolveType: "website/pages/Page.tsx", path: "/" } },
      ifMatch: { home: null },
    });
    expect(saved.body.error).toBeUndefined();
    const index = await t.rpc("acme", "d", "cms.index", {});
    const draft = await t.call("GET", "acme/drafts/d");
    return { index: index.body.result, pointer: draft.body.pointer };
  }

  let warn: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it("drafts, saves, the index and the token answer as on a fresh site", async () => {
    const t = cmsTestApp();
    malformed(t);
    const fresh = cmsTestApp();
    const over = await saveAndRead(t);
    const clean = await saveAndRead(fresh);
    expect(Object.keys(over.index.entries)).toEqual(["home"]);
    expect(over.index.revision).toBe(clean.index.revision);
    expect(over.pointer.endsWith(`@${over.index.revision}`)).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      "cms: latest.json is malformed; read as no release yet",
      expect.objectContaining({ site: "acme", why: "revision is not an id" }),
    );
  });

  it("releases list none; a publish replaces it as the site's first release", async () => {
    const t = cmsTestApp();
    malformed(t);
    const before = await t.call("GET", "acme/releases");
    expect(before.status).toBe(200);
    expect(before.body).toEqual({
      live: null,
      revisions: [],
      nextCursor: null,
    });
    await saveAndRead(t);
    const published = await t.call("POST", "acme/drafts/d/publish", {});
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({
      result: "published",
      previous: null,
    });
    const after = await t.call("GET", "acme/releases");
    expect(after.body.live).toBe(published.body.revision);
    expect(after.body.revisions).toEqual([
      expect.objectContaining({
        id: published.body.revision,
        status: "current",
      }),
    ]);
    const latest = JSON.parse(
      t.delivery.objects.get(deliveryKeys.latest("acme"))!.text,
    );
    // Past the malformed object's own sequence (3).
    expect(latest).toMatchObject({
      revision: published.body.revision,
      sequence: 4,
    });
  });
  it("a rollback replaces it: the target is live, recorded as made current", async () => {
    const t = cmsTestApp();
    const target = newRevisionId(Date.parse("2026-11-01T00:00:00.000Z"));
    await seedRelease(
      t.delivery.store,
      "acme",
      target,
      { a: { id: "a" } },
      { message: "Summer sale" },
    );
    malformed(t);
    const res = await t.call("POST", `acme/releases/${target}/rollback`, {});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ result: "published", previous: null });
    const id = res.body.revision as string;
    const latest = JSON.parse(
      t.delivery.objects.get(deliveryKeys.latest("acme"))!.text,
    );
    // Past both the target's sequence (1) and the malformed object's (3).
    expect(latest).toMatchObject({ revision: id, sequence: 4 });
    const after = await t.call("GET", "acme/releases");
    expect(after.body.live).toBe(id);
    expect(after.body.revisions[0]).toMatchObject({
      id,
      status: "current",
      meta: expect.objectContaining({
        reapplyOf: target,
        previous: null,
        message: "Made current: Summer sale",
      }),
    });
  });

  it("a rollback over it to a malformed target index is still 500 malformed", async () => {
    const t = cmsTestApp();
    const target = newRevisionId(Date.parse("2026-11-01T00:00:00.000Z"));
    await seedRelease(t.delivery.store, "acme", target, { a: { id: "a" } });
    malformed(t);
    t.delivery.objects.set(deliveryKeys.revisionIndex("acme", target), {
      text: "{not json",
      etag: '"x"',
      cacheControl: "",
    });
    const res = await t.call("POST", `acme/releases/${target}/rollback`, {});
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: `sites/acme/revisions/${target}/index.json is malformed`,
      code: "malformed",
    });
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
