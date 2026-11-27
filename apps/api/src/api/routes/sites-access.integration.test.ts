/**
 * `GET /api/:org/sites/:site/access` through the whole app against real
 * Postgres: each way sites.decocms.com's caller authenticates (a browser
 * session, an MCP OAuth access token, an `x-studio-token` alone), and the
 * site's tenancy. Better Auth's session lookups are the only stubs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { sql } from "kysely";
import { auth } from "../../auth";
import { CHANNELS_TOKEN_AUDIENCE, issueStudioToken } from "../../auth/jwt";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
  seedCommonTestPgFixtures,
} from "../../database/test-db-pg";
import { invalidateOrgNoticeCache } from "../../core/org-notice-gate";
import { OrgSiteStorage } from "../../storage/org-sites";
import { OrganizationNoticeStorage } from "../../storage/organization-notices";
import { VirtualMCPStorage } from "../../storage/virtual";
import { createApp } from "../app";

const ORG = "org_1";
const OTHER_ORG = "org_456";
const USER = "user_1";
const OUTSIDER = "user_outsider";

function studioToken(organizationId: string, extra: { aud?: "channels" } = {}) {
  return issueStudioToken({
    sub: USER,
    user: { id: USER },
    metadata: {
      studioUrl: "http://test",
      connectionId: "conn_sites",
      organizationId,
      organizationSlug: organizationId,
    },
    permissions: {},
    ...extra,
  });
}

describe("GET /api/:org/sites/:site/access", () => {
  let database: StudioDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let projectId: string;

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.fetch(new Request(`http://test${path}`, { headers }));

  const asSession = (userId: string) =>
    vi.spyOn(auth.api, "getSession").mockImplementation((async () => ({
      user: { id: userId, email: `${userId}@test.com`, emailVerified: false },
      session: { activeOrganizationId: null },
    })) as never);

  beforeEach(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    await seedCommonTestPgFixtures(database);
    const now = new Date().toISOString();
    await sql`
      INSERT INTO "user" (id, email, "emailVerified", name, "createdAt", "updatedAt")
      VALUES (${OUTSIDER}, 'outsider@test.com', false, 'Outsider', ${now}, ${now})
    `.execute(database.db);
    // A member of two organizations, so only the path can pick the org.
    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES ('mem_1', ${USER}, ${ORG}, 'user', ${now}),
             ('mem_2', ${USER}, ${OTHER_ORG}, 'admin', ${now})
    `.execute(database.db);

    const projects = new VirtualMCPStorage(database.db);
    const project = await projects.create(ORG, USER, {
      title: "Acme storefront",
      metadata: {
        blocksV8: true,
        previewServerUrl: "https://preview.example.com/",
      },
      connections: [],
      status: "active",
      pinned: false,
    });
    projectId = project.id;
    const sites = new OrgSiteStorage(database.db);
    await sites.claimSite({ slug: "acme", organizationId: ORG, by: USER });
    await sites.link({
      slug: "acme",
      organizationId: ORG,
      projectId,
      by: USER,
    });
    await sites.claimSite({
      slug: "beta",
      organizationId: OTHER_ORG,
      by: USER,
    });

    app = await createApp({ database, disableNats: true });
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue(null);
    vi.spyOn(auth.api, "getSession").mockResolvedValue(null);
  });

  afterEach(async () => {
    // The notice cache outlives the database reset.
    invalidateOrgNoticeCache(ORG);
    vi.restoreAllMocks();
    if (app) await app.shutdown();
    if (database) await closeTestPgDatabase(database);
  });

  const expected = () => ({
    org: { id: ORG, slug: ORG, name: ORG },
    site: "acme",
    project: { id: projectId, title: "Acme storefront" },
    blocksV8: true,
    role: "user",
    canRead: true,
    canWrite: true,
    cmsFeature: true,
    previewUrl: "https://preview.example.com/",
  });

  it("200 for a browser session, not cached", async () => {
    asSession(USER);
    const res = await get(`/api/${ORG}/sites/acme/access`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(expected());
  });

  it("200 for an MCP OAuth access token, in the org the path names", async () => {
    vi.spyOn(auth.api, "getMcpSession").mockResolvedValue({
      userId: USER,
      scopes: "openid",
    } as never);
    const res = await get(`/api/${ORG}/sites/acme/access`, {
      Authorization: "Bearer opaque-oauth-access-token",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(expected());
  });

  it("200 for an x-studio-token alone, with the member's current role", async () => {
    const res = await get(`/api/${ORG}/sites/acme/access`, {
      "x-studio-token": await studioToken(ORG),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual(expected());
  });

  it("403 for an x-studio-token of another organization", async () => {
    const res = await get(`/api/${ORG}/sites/acme/access`, {
      "x-studio-token": await studioToken(OTHER_ORG),
    });
    expect(res.status).toBe(403);
  });

  it("401 for an x-studio-token that is a channels token, or not Studio's", async () => {
    const channels = await get(`/api/${ORG}/sites/acme/access`, {
      "x-studio-token": await studioToken(ORG, {
        aud: CHANNELS_TOKEN_AUDIENCE,
      }),
    });
    expect(channels.status).toBe(401);
    const forged = await get(`/api/${ORG}/sites/acme/access`, {
      "x-studio-token": `${await studioToken(ORG)}x`,
    });
    expect(forged.status).toBe(401);
  });

  it("an x-studio-token alone authenticates no other route", async () => {
    const token = await studioToken(ORG);
    const call = (headers: Record<string, string>) =>
      app.fetch(
        new Request(
          `http://test/api/${ORG}/tools/COLLECTION_CONNECTIONS_LIST`,
          {
            method: "POST",
            headers: { "content-type": "application/json", ...headers },
            body: "{}",
          },
        ),
      );
    // Unauthenticated: the tool's access check refuses it.
    expect((await call({ "x-studio-token": token })).status).toBe(403);
    // The same token as a Bearer credential gets past that route's auth.
    expect((await call({ Authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it("401 with no credential", async () => {
    const res = await get(`/api/${ORG}/sites/acme/access`);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("403 for a non-member", async () => {
    asSession(OUTSIDER);
    const res = await get(`/api/${ORG}/sites/acme/access`);
    expect(res.status).toBe(403);
  });

  it("404 for a site of another organization, even to a member of both", async () => {
    asSession(USER);
    const res = await get(`/api/${ORG}/sites/beta/access`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "Site not found",
      code: "site_not_found",
    });
    // In its own organization it answers, with that org's role.
    const own = await get(`/api/${OTHER_ORG}/sites/beta/access`);
    expect(own.status).toBe(200);
    expect(await own.json()).toMatchObject({
      site: "beta",
      role: "admin",
      project: null,
      blocksV8: false,
      previewUrl: null,
    });
  });

  it("404 for an unknown site", async () => {
    asSession(USER);
    const res = await get(`/api/${ORG}/sites/nope/access`);
    expect(res.status).toBe(404);
  });

  it("canWrite is false while the organization is blocked", async () => {
    asSession(USER);
    await new OrganizationNoticeStorage(database.db).setActive({
      organizationId: ORG,
      notice: { severity: "block", title: "Overdue", message: "Pay the bill" },
      by: USER,
    });
    invalidateOrgNoticeCache(ORG);
    const res = await get(`/api/${ORG}/sites/acme/access`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ canRead: true, canWrite: false });
  });
});
