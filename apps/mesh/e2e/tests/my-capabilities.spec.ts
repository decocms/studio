/**
 * E2E: GET /api/auth/custom/my-capabilities/:slug
 *
 * The endpoint resolves the caller's gated permission capabilities in a given
 * org into a { role, capabilities } bitmap — the server-side source of truth
 * for UI gating. These specs exercise the auth + org-resolution + membership
 * wiring through the real stack; the pure resolution matrix (which permission
 * shapes grant which capabilities) is unit-tested in
 * src/tools/registry-metadata.test.ts.
 */

import type { Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

const ENDPOINT = (slug: string) =>
  `/api/auth/custom/my-capabilities/${encodeURIComponent(slug)}`;

interface CapabilitiesResponse {
  role: string | null;
  capabilities: Record<string, boolean>;
}

test.describe("GET /api/auth/custom/my-capabilities/:slug", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("returns 401 when unauthenticated", async ({ playwright }) => {
    const anon = await newApiContext(playwright);
    const res = await anon.get(ENDPOINT(`unused-${Date.now()}`));
    expect(res.status()).toBe(401);
    await anon.dispose();
  });

  test("grants every capability to the org owner", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    const owner = await signUpViaApi(ctx);

    const res = await ctx.get(ENDPOINT(owner.orgSlug));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as CapabilitiesResponse;

    expect(body.role).toBe("owner");
    const values = Object.values(body.capabilities);
    expect(values.length).toBeGreaterThan(0);
    expect(values.every((v) => v === true)).toBe(true);

    await ctx.dispose();
  });

  test("grants no gated capability to a plain member (built-in user role)", async ({
    playwright,
  }) => {
    // Owner of org A.
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const orgRow = await db.query<{ id: string }>(
      `SELECT id FROM "organization" WHERE slug = $1`,
      [owner.orgSlug],
    );
    const orgId = orgRow.rows[0]?.id;
    if (!orgId) throw new Error("org A not found after signup");

    // A second user, invited into org A with the built-in "user" role.
    const memberCtx = await newApiContext(playwright);
    const member = await signUpViaApi(memberCtx);

    const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
      data: { organizationId: orgId, email: member.email, role: "user" },
    });
    expect(invite.ok()).toBe(true);
    const inviteJson = (await invite.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const invitationId = inviteJson.id ?? inviteJson.invitation?.id;
    expect(invitationId).toBeTruthy();

    const accept = await memberCtx.post(
      "/api/auth/organization/accept-invitation",
      { data: { invitationId } },
    );
    expect(
      accept.ok(),
      `accept-invitation failed: ${await accept.text().catch(() => "")}`,
    ).toBe(true);

    const res = await memberCtx.get(ENDPOINT(owner.orgSlug));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as CapabilitiesResponse;

    expect(body.role).toBe("user");
    // The built-in user role is granted agents:manage via USER_ROLE_CAPABILITY_IDS;
    // every other gated capability stays false.
    expect(body.capabilities["agents:manage"]).toBe(true);
    const others = Object.entries(body.capabilities)
      .filter(([id]) => id !== "agents:manage")
      .map(([, granted]) => granted);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((granted) => granted === false)).toBe(true);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });

  test("returns no role for a non-member of the org", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);

    // Outsider has their own org but no membership in the owner's org.
    const outsiderCtx = await newApiContext(playwright);
    await signUpViaApi(outsiderCtx);

    const res = await outsiderCtx.get(ENDPOINT(owner.orgSlug));
    expect(res.status()).toBe(200);
    const body = (await res.json()) as CapabilitiesResponse;
    expect(body.role).toBeNull();
    expect(body.capabilities).toEqual({});

    await ownerCtx.dispose();
    await outsiderCtx.dispose();
  });
});
