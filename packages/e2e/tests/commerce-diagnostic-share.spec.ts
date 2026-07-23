/**
 * Commerce-diagnostic share-invite route — the service-token path behind the
 * "Share this diagnostic" button (commerce-discovery's `share_my_diagnostic`
 * tool calls it).
 *
 *   POST /api/:org/internal/commerce-diagnostic/share-invite
 *
 * The raw-SQL `insert into invitation` here writes a Better-Auth-managed table
 * that isn't in the Kysely schema, so an in-memory fake would happily accept a
 * column Postgres rejects (exactly the `teamId` bug this route already shipped
 * and reverted). This exercises it over the wire against real Postgres and
 * asserts the invitation rows it writes.
 *
 * Kept in sync by hand with playwright.config.ts's `vaultServiceToken`.
 */

import type { PlaywrightWorkerArgs } from "@playwright/test";
import { type Client } from "pg";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { expect, getE2EAppOrigin, test } from "../fixtures/test";

type Playwright = PlaywrightWorkerArgs["playwright"];

const TOKEN = "e2e-vault-service-token";
const ROUTE = (org: string) =>
  `/api/${org}/internal/commerce-diagnostic/share-invite`;

// Unique email domain per run keeps invitee addresses from colliding across
// parallel workers (the one global namespace, per TESTING.md).
const EMAIL_DOMAIN = `share-e2e-${Date.now()}.test`;

test.describe("commerce-diagnostic share-invite", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  async function svcContext(playwright: Playwright) {
    const baseURL = getE2EAppOrigin();
    return playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Origin: baseURL, authorization: `Bearer ${TOKEN}` },
    });
  }

  async function pendingInvites(orgId: string, email: string) {
    const { rows } = await db.query<{ id: string }>(
      `select id from invitation
         where lower(email) = lower($1) and "organizationId" = $2
           and status = 'pending' and "expiresAt" > now()`,
      [email, orgId],
    );
    return rows;
  }

  async function orgIdForSlug(slug: string) {
    const { rows } = await db.query<{ id: string }>(
      `select id from "organization" where slug = $1`,
      [slug],
    );
    return rows[0]?.id;
  }

  test("new invitee → pending invitation + accept URL that deep-links the report", async ({
    page,
    playwright,
  }) => {
    const owner = await signUpViaApi(page.context().request);
    const orgId = await orgIdForSlug(owner.orgSlug);
    expect(orgId).toBeTruthy();
    const invitee = `newbie-${Date.now()}@${EMAIL_DOMAIN}`;

    const svc = await svcContext(playwright);
    const res = await svc.post(ROUTE(owner.orgSlug), {
      data: { invitee_email: invitee },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.invitee_status).toBe("new");
    // Accept URL carries the invitation and a relative redirectTo that opens
    // the report on the org home.
    expect(body.accept_url).toContain("/auth/accept-invitation?invitationId=");
    const redirectTo = new URL(body.accept_url).searchParams.get("redirectTo");
    expect(redirectTo?.startsWith(`/${owner.orgSlug}/`)).toBe(true);
    expect(redirectTo).toContain("get_my_diagnostic");

    const invites = await pendingInvites(orgId!, invitee);
    expect(invites).toHaveLength(1);

    // Re-share the same email: reuse the row, don't stack a second one.
    const again = await svc.post(ROUTE(owner.orgSlug), {
      data: { invitee_email: invitee },
    });
    expect(again.status()).toBe(200);
    expect((await again.json()).invitee_status).toBe("new");
    expect(await pendingInvites(orgId!, invitee)).toHaveLength(1);

    await db.query(`delete from invitation where "organizationId" = $1`, [
      orgId,
    ]);
    await svc.dispose();
  });

  test("existing member → no invitation, direct deep link", async ({
    page,
    playwright,
  }) => {
    const owner = await signUpViaApi(page.context().request);
    const orgId = await orgIdForSlug(owner.orgSlug);

    const svc = await svcContext(playwright);
    const res = await svc.post(ROUTE(owner.orgSlug), {
      data: { invitee_email: owner.email },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.invitee_status).toBe("member");
    // The member skips the invite: the CTA is the report deep link itself.
    expect(body.accept_url).not.toContain("accept-invitation");
    expect(body.accept_url).toContain(`/${owner.orgSlug}/`);
    expect(await pendingInvites(orgId!, owner.email)).toHaveLength(0);

    await svc.dispose();
  });

  test("existing account, not a member → pending invitation, status existing", async ({
    page,
    playwright,
  }) => {
    const owner = await signUpViaApi(page.context().request);
    const orgId = await orgIdForSlug(owner.orgSlug);
    // A second real Studio account (in its own org, not the owner's).
    const outsider = await signUpViaApi(
      await playwright.request.newContext({ baseURL: getE2EAppOrigin() }),
    );

    const svc = await svcContext(playwright);
    const res = await svc.post(ROUTE(owner.orgSlug), {
      data: { invitee_email: outsider.email },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).invitee_status).toBe("existing");
    expect(await pendingInvites(orgId!, outsider.email)).toHaveLength(1);

    await db.query(`delete from invitation where "organizationId" = $1`, [
      orgId,
    ]);
    await svc.dispose();
  });

  test("rejects a missing/invalid bearer and a bad body", async ({
    page,
    playwright,
  }) => {
    const owner = await signUpViaApi(page.context().request);
    const baseURL = getE2EAppOrigin();

    const noAuth = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Origin: baseURL },
    });
    const unauth = await noAuth.post(ROUTE(owner.orgSlug), {
      data: { invitee_email: `x@${EMAIL_DOMAIN}` },
    });
    expect(unauth.status()).toBe(401);
    await noAuth.dispose();

    const svc = await svcContext(playwright);
    const bad = await svc.post(ROUTE(owner.orgSlug), {
      data: { invitee_email: "not-an-email" },
    });
    expect(bad.status()).toBe(400);
    await svc.dispose();
  });
});
