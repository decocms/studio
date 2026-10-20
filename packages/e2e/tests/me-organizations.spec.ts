/**
 * `GET /api/_me/organizations` lists the caller's organizations without an
 * org in the path, so a CLI or MCP client can find a slug before its first
 * org-scoped call. Real signups, a real OAuth token, assertions on HTTP only.
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { findOrgId } from "../fixtures/mcp-tools";
import { mintMcpAccessToken } from "../fixtures/mcp-oauth";
import { expect, newApiContext, test } from "../fixtures/test";

interface Organization {
  id: string;
  slug: string;
  name: string;
}

async function listSlugs(
  ctx: APIRequestContext,
  headers?: Record<string, string>,
): Promise<string[]> {
  const res = await ctx.get("/api/_me/organizations", { headers });
  expect(res.status(), await res.text()).toBe(200);
  const { organizations } = (await res.json()) as {
    organizations: Organization[];
  };
  return organizations.map((o) => o.slug).sort();
}

test.describe("GET /api/_me/organizations", () => {
  test("lists only the caller's live organizations, for a session and an OAuth bearer", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const secondSlug = `second-${suffix}`;
    const created = await ownerCtx.post("/api/auth/organization/create", {
      data: { name: `Second ${suffix}`, slug: secondSlug },
    });
    expect(created.ok()).toBe(true);

    expect(await listSlugs(ownerCtx)).toEqual(
      [owner.orgSlug, secondSlug].sort(),
    );

    const { accessToken } = await mintMcpAccessToken(ownerCtx);
    const bearerCtx = await newApiContext(playwright);
    const bearer = { authorization: `Bearer ${accessToken}` };
    expect(await listSlugs(bearerCtx, bearer)).toEqual(
      [owner.orgSlug, secondSlug].sort(),
    );

    // Archived organizations drop out.
    const secondId = await findOrgId(ownerCtx, secondSlug);
    const archived = await ownerCtx.post(
      `/api/${secondSlug}/tools/ORGANIZATION_DELETE`,
      { data: { id: secondId } },
    );
    expect(archived.status(), await archived.text()).toBe(200);
    expect(await listSlugs(bearerCtx, bearer)).toEqual([owner.orgSlug]);

    // Another user sees only their own organization.
    const outsiderCtx = await newApiContext(playwright);
    const outsider = await signUpViaApi(outsiderCtx);
    expect(await listSlugs(outsiderCtx)).toEqual([outsider.orgSlug]);

    await outsiderCtx.dispose();
    await bearerCtx.dispose();
    await ownerCtx.dispose();
  });

  test("rejects an anonymous caller", async ({ playwright }) => {
    const anonCtx = await newApiContext(playwright);
    const res = await anonCtx.get("/api/_me/organizations");
    expect(res.status()).toBe(401);
    await anonCtx.dispose();
  });
});
