/**
 * Infra Billing is scoped by `org_sites` ownership, and that ownership is the
 * ONLY thing standing between one tenant and another tenant's usage and
 * invoices — site slugs are globally unique and guessable (they're public
 * hostnames). So this asserts, over the wire:
 *
 *   - a fresh org owns nothing → the feature is absent (empty site list);
 *   - the owning org reads its own site;
 *   - a second org asking for that same slug is rejected, not served.
 *
 * The usage numbers themselves need the legacy analytics warehouse, which the
 * e2e stack has no credentials for; the ownership gate runs before any of that
 * and is what a regression would silently break.
 */

import { type Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

interface SitesList {
  sites: { slug: string }[];
}

test.describe("Infra billing site tenancy", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("only the owning org can read a site's infra billing", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const otherCtx = await newApiContext(playwright);
    const other = await signUpViaApi(otherCtx);

    // Fresh orgs own no site — the nav gate reads exactly this.
    const before = await callSelfMcpTool<SitesList>(
      ownerCtx,
      owner.orgSlug,
      "INFRA_BILLING_SITES_LIST",
      {},
    );
    expect(before.sites).toEqual([]);

    const slug = `e2e-site-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ownerOrgId = (
      await db.query<{ id: string }>(
        `SELECT id FROM "organization" WHERE slug = $1`,
        [owner.orgSlug],
      )
    ).rows[0]!.id;

    await db.query(
      `INSERT INTO org_sites
         (slug, organization_id, source, created_by, updated_by)
       VALUES ($1, $2, 'manual', $3, $3)`,
      [slug, ownerOrgId, owner.userId],
    );

    try {
      const after = await callSelfMcpTool<SitesList>(
        ownerCtx,
        owner.orgSlug,
        "INFRA_BILLING_SITES_LIST",
        {},
      );
      expect(after.sites).toEqual([{ slug }]);

      // The owner is served (usage may be empty without a warehouse).
      const billing = await callSelfMcpTool<{ siteSlugs: string[] }>(
        ownerCtx,
        owner.orgSlug,
        "INFRA_BILLING_GET",
        { siteSlugs: [slug] },
      );
      expect(billing.siteSlugs).toEqual([slug]);

      // The gate inspects EVERY slug, not just the first one.
      await expect(
        callSelfMcpTool(ownerCtx, owner.orgSlug, "INFRA_BILLING_GET", {
          siteSlugs: [slug, `${slug}-not-owned`],
        }),
      ).rejects.toThrow(/not found/i);

      // A different tenant naming the same slug must be refused.
      expect(other.orgSlug).not.toBe(owner.orgSlug);
      await expect(
        callSelfMcpTool(otherCtx, other.orgSlug, "INFRA_BILLING_GET", {
          siteSlugs: [slug],
        }),
      ).rejects.toThrow(/not found/i);

      // Same gate on the portal — it mints a Stripe session for the site's team.
      await expect(
        callSelfMcpTool(otherCtx, other.orgSlug, "INFRA_BILLING_PORTAL", {
          siteSlug: slug,
        }),
      ).rejects.toThrow(/not found/i);

      const otherSites = await callSelfMcpTool<SitesList>(
        otherCtx,
        other.orgSlug,
        "INFRA_BILLING_SITES_LIST",
        {},
      );
      expect(otherSites.sites).toEqual([]);
    } finally {
      await db.query(`DELETE FROM org_sites WHERE slug = $1`, [slug]);
    }
  });
});
