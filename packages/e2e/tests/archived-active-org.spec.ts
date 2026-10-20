/**
 * A session's `activeOrganizationId` is whatever org the user last switched
 * to, and archiving an org never clears it from the members' session rows.
 * That stale pointer used to fail authentication itself, so archiving one org
 * locked its members out of EVERY org with "Authentication required".
 *
 * The repro runs over `/api/:org/tools/:name` because that REST dispatch is
 * what the web app uses and it sends no `x-org-*` header — the org comes from
 * the path, which is exactly the case the session fallback must not override.
 */

import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

test.describe("archived active organization", () => {
  test("does not break requests to the user's other orgs", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const user = await signUpViaApi(ctx);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const doomedSlug = `doomed-${suffix}`;
    const created = await ctx.post("/api/auth/organization/create", {
      data: { name: `Doomed ${suffix}`, slug: doomedSlug },
    });
    expect(created.ok()).toBe(true);

    const doomedOrgId = await findOrgId(ctx, doomedSlug);
    const setActive = await ctx.post("/api/auth/organization/set-active", {
      data: { organizationId: doomedOrgId },
    });
    expect(setActive.ok()).toBe(true);

    await callSelfMcpTool(ctx, doomedSlug, "ORGANIZATION_DELETE", {
      id: doomedOrgId,
    });

    // The session still points at the archived org here — nothing clears it.
    const res = await ctx.post(
      `/api/${user.orgSlug}/tools/ORGANIZATION_SETTINGS_GET`,
      { data: {} },
    );
    expect(res.status()).toBe(200);

    await ctx.dispose();
  });

  test("still reads as archived when the request targets it", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    await signUpViaApi(ctx);

    const suffix = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    const doomedSlug = `gone-${suffix}`;
    const created = await ctx.post("/api/auth/organization/create", {
      data: { name: `Gone ${suffix}`, slug: doomedSlug },
    });
    expect(created.ok()).toBe(true);

    const doomedOrgId = await findOrgId(ctx, doomedSlug);
    await callSelfMcpTool(ctx, doomedSlug, "ORGANIZATION_DELETE", {
      id: doomedOrgId,
    });

    // Archived, not unauthenticated.
    const res = await ctx.post(
      `/api/${doomedSlug}/tools/ORGANIZATION_SETTINGS_GET`,
      { data: {} },
    );
    expect(res.status()).toBe(404);

    await ctx.dispose();
  });
});
