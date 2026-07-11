/**
 * E2E: `POST /api/companion/provision` turns a `deco link` identity into MCP
 * entries for the local companion app. Proven over HTTP only:
 *
 *   - an owner/admin org is provisioned with a key that ACTUALLY authorizes the
 *     org's MCP surface (the whole point — a mis-scoped key would 403);
 *   - a member org is SKIPPED (reason `requires-elevated-role`), because a flat
 *     wildcard key handed to a non-admin would be a privilege escalation;
 *   - re-provision REVOKES the prior companion key (no 90-day key sprawl): the
 *     first key stops authenticating once the second is minted.
 *
 * The endpoint authenticates with a `deco link` bearer; `resolveLinkBearer`
 * accepts a Better Auth API key as that bearer (its dev fallback), so we mint a
 * throwaway identity key per user and send it as `Authorization: Bearer`.
 */
import { signUpViaApi } from "../fixtures/auth-api";
import { expect, newApiContext, test } from "../fixtures/test";

import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test";

type Playwright = PlaywrightWorkerArgs["playwright"];

interface ProvisionResponse {
  studioUrl: string;
  orgs: Array<{
    id: string;
    slug: string;
    name: string;
    url: string;
    key: string;
  }>;
  skipped: Array<{ id: string; slug: string; name: string; reason: string }>;
}

const bearer = (key: string) => ({ Authorization: `Bearer ${key}` });

/** Mint a throwaway API key (owner cookie session authorizes the call). Its
 * scope is irrelevant — it's only used to resolve the caller's identity. */
async function mintIdentityKey(
  ownerCtx: APIRequestContext,
  orgSlug: string,
  stamp: string,
): Promise<string> {
  const res = await ownerCtx.post(`/api/${orgSlug}/tools/API_KEY_CREATE`, {
    data: {
      name: `identity-${stamp}`,
      permissions: { self: ["AUTOMATION_LIST"] },
    },
  });
  expect(res.ok(), `identity API_KEY_CREATE: HTTP ${res.status()}`).toBe(true);
  const key = ((await res.json()) as { key?: string }).key;
  expect(key, "identity key value returned").toBeTruthy();
  return key!;
}

async function provision(
  playwright: Playwright,
  identityKey: string,
): Promise<{ status: number; body: ProvisionResponse }> {
  const ctx = await newApiContext(playwright);
  const res = await ctx.post("/api/companion/provision", {
    headers: bearer(identityKey),
    data: {},
  });
  const status = res.status();
  const body = (await res.json().catch(() => ({}))) as ProvisionResponse;
  await ctx.dispose();
  return { status, body };
}

test.describe("companion provisioning", () => {
  test("provisions an owner org with an authorizing key; skips member orgs", async ({
    playwright,
  }) => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

    // Owner of orgA + a second user who will be only a MEMBER of orgA.
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const memberCtx = await newApiContext(playwright);
    const member = await signUpViaApi(memberCtx);

    // Resolve orgA's id so we can invite by organizationId.
    const listRes = await ownerCtx.get("/api/auth/organization/list");
    const orgs = (await listRes.json()) as Array<{ id: string; slug: string }>;
    const orgAId = (Array.isArray(orgs) ? orgs : []).find(
      (o) => o.slug === owner.orgSlug,
    )?.id;
    expect(orgAId, "orgA id resolved").toBeTruthy();

    // member joins orgA as a plain `user` (non-admin).
    const invite = await ownerCtx.post("/api/auth/organization/invite-member", {
      data: { organizationId: orgAId, email: member.email, role: "user" },
    });
    expect(invite.ok(), `invite: HTTP ${invite.status()}`).toBe(true);
    const inviteJson = (await invite.json()) as {
      id?: string;
      invitation?: { id?: string };
    };
    const invitationId = inviteJson.id ?? inviteJson.invitation?.id;
    const accept = await memberCtx.post(
      "/api/auth/organization/accept-invitation",
      { data: { invitationId } },
    );
    expect(accept.ok(), `accept: HTTP ${accept.status()}`).toBe(true);

    // --- Owner provisions: orgA is provisioned (owner), nothing skipped. ---
    const ownerKey = await mintIdentityKey(ownerCtx, owner.orgSlug, stamp);
    const { status, body } = await provision(playwright, ownerKey);
    expect(status, "provision HTTP status").toBe(200);

    const orgA = body.orgs.find((o) => o.slug === owner.orgSlug);
    expect(orgA, "orgA provisioned for its owner").toBeTruthy();
    expect(orgA!.url).toContain(
      `/api/${owner.orgSlug}/mcp/virtual-mcp/decopilot_`,
    );
    expect(orgA!.key, "companion key returned").toBeTruthy();
    expect(
      body.skipped.some((s) => s.slug === owner.orgSlug),
      "owner org not skipped",
    ).toBe(false);

    // The minted key must ACTUALLY authorize the org's MCP surface. A wildcard
    // management tool that a scoped/mis-scoped key would 403 on: not 403 here.
    const apiCtx = await newApiContext(playwright);
    const reach = await apiCtx.post(
      `/api/${owner.orgSlug}/tools/MONITORING_STATS`,
      { headers: bearer(orgA!.key), data: {} },
    );
    expect(
      reach.status(),
      `companion key MONITORING_STATS must not be 403, got ${reach.status()}`,
    ).not.toBe(403);
    await apiCtx.dispose();

    // --- Member provisions: orgA is SKIPPED (member is only `user` there). ---
    const memberKey = await mintIdentityKey(memberCtx, member.orgSlug, stamp);
    const memberProv = await provision(playwright, memberKey);
    expect(memberProv.status).toBe(200);
    const skippedA = memberProv.body.skipped.find(
      (s) => s.slug === owner.orgSlug,
    );
    expect(skippedA, "orgA skipped for the member").toBeTruthy();
    expect(skippedA!.reason).toBe("requires-elevated-role");
    expect(
      memberProv.body.orgs.some((o) => o.slug === owner.orgSlug),
      "member must NOT get a key for an org they don't administer",
    ).toBe(false);
    // Their own org (where they are owner) IS provisioned.
    expect(
      memberProv.body.orgs.some((o) => o.slug === member.orgSlug),
      "member's own org provisioned",
    ).toBe(true);

    await ownerCtx.dispose();
    await memberCtx.dispose();
  });

  test("re-provision revokes the prior companion key", async ({
    playwright,
  }) => {
    const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const identityKey = await mintIdentityKey(ownerCtx, owner.orgSlug, stamp);

    const first = await provision(playwright, identityKey);
    const key1 = first.body.orgs.find((o) => o.slug === owner.orgSlug)?.key;
    expect(key1, "first key minted").toBeTruthy();

    // key1 authorizes before re-provision.
    const ctx1 = await newApiContext(playwright);
    const before = await ctx1.post(
      `/api/${owner.orgSlug}/tools/MONITORING_STATS`,
      { headers: bearer(key1!), data: {} },
    );
    expect(before.status(), "key1 works before re-provision").not.toBe(403);
    await ctx1.dispose();

    const second = await provision(playwright, identityKey);
    const key2 = second.body.orgs.find((o) => o.slug === owner.orgSlug)?.key;
    expect(key2, "second key minted").toBeTruthy();
    expect(key2, "re-provision mints a fresh key").not.toBe(key1);

    // key1 is revoked → no longer authorized (a deleted key is rejected as an
    // invalid principal: 401 or, on this org-scoped route, 403 — never a 2xx).
    const ctx2 = await newApiContext(playwright);
    const revoked = await ctx2.post(
      `/api/${owner.orgSlug}/tools/MONITORING_STATS`,
      { headers: bearer(key1!), data: {} },
    );
    expect(
      [401, 403],
      `revoked key1 must be rejected, got ${revoked.status()}`,
    ).toContain(revoked.status());
    const stillWorks = await ctx2.post(
      `/api/${owner.orgSlug}/tools/MONITORING_STATS`,
      { headers: bearer(key2!), data: {} },
    );
    expect(stillWorks.status(), "key2 works after re-provision").not.toBe(403);
    await ctx2.dispose();

    await ownerCtx.dispose();
  });
});
