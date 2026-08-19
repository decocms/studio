/**
 * `/api/_editor-resolve` is what the storefront "." shortcut lands on: it maps
 * a `(site, domain)` pair to the owning org's project(s) so `/choose-editor`
 * can open the content editor. The resolution is authoritative through
 * `org_sites` (globally-unique, guessable slugs), so the membership gate is the
 * only thing keeping one tenant from discovering another's org/projects. This
 * asserts, over the wire:
 *
 *   - the owning member resolves the site to their project;
 *   - a signed-in non-member is refused (403), not served the org;
 *   - an anonymous caller is refused (401);
 *   - an unknown or malformed slug fails cleanly (404 / 400).
 */

import { type Client } from "pg";
import { connectDevDb } from "../fixtures/db";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

interface ResolveResult {
  orgSlug: string;
  projects: { id: string; title: string; previewServerUrl: string | null }[];
}

test.describe("Editor resolve (choose-editor backend)", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db?.end();
  });

  test("resolves a site to the owning org's project and gates by membership", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const otherCtx = await newApiContext(playwright);
    const other = await signUpViaApi(otherCtx);
    const anonCtx = await newApiContext(playwright);

    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const slug = `e2e-editor-${suffix}`;
    const domain = `https://shop-${suffix}.example.com`;

    // metadata.siteSlug is the resolver's primary key; previewServerUrl the fallback.
    const created = await callSelfMcpTool<{ item: { id: string } }>(
      ownerCtx,
      owner.orgSlug,
      "COLLECTION_VIRTUAL_MCP_CREATE",
      {
        data: {
          title: `Editor resolve e2e ${suffix}`,
          connections: [],
          metadata: {
            instructions: null,
            siteSlug: slug,
            previewServerUrl: domain,
          },
        },
      },
    );
    const projectId = created.item.id;
    expect(projectId).toBeTruthy();

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

    const resolveUrl = (site: string, dom?: string) =>
      `/api/_editor-resolve?site=${encodeURIComponent(site)}` +
      (dom ? `&domain=${encodeURIComponent(dom)}` : "");

    try {
      // The owning member resolves the site to their project.
      const ok = await ownerCtx.get(resolveUrl(slug, domain));
      expect(ok.status()).toBe(200);
      const body = (await ok.json()) as ResolveResult;
      expect(body.orgSlug).toBe(owner.orgSlug);
      expect(body.projects.map((p) => p.id)).toContain(projectId);

      // A different casing of the site name still resolves (slug is lowercased).
      const okUpper = await ownerCtx.get(
        resolveUrl(slug.toUpperCase(), domain),
      );
      expect(okUpper.status()).toBe(200);

      // A signed-in non-member must not learn who owns the site.
      expect(other.orgSlug).not.toBe(owner.orgSlug);
      const forbidden = await otherCtx.get(resolveUrl(slug, domain));
      expect(forbidden.status()).toBe(403);

      // Anonymous caller: refused before any lookup.
      const anon = await anonCtx.get(resolveUrl(slug, domain));
      expect(anon.status()).toBe(401);

      // Unknown site → clean 404, not a 500.
      const missing = await ownerCtx.get(resolveUrl(`${slug}-nope`, domain));
      expect(missing.status()).toBe(404);

      // Malformed slug → 400.
      const bad = await ownerCtx.get(resolveUrl("Not A Slug!", domain));
      expect(bad.status()).toBe(400);
    } finally {
      await db.query(`DELETE FROM org_sites WHERE slug = $1`, [slug]);
      await ownerCtx.dispose();
      await otherCtx.dispose();
      await anonCtx.dispose();
    }
  });
});
