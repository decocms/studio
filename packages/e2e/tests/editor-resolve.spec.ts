/**
 * `/api/_editor-resolve` is what the storefront "." shortcut lands on: given a
 * site name it returns every (org, project) — across the orgs the *caller* is a
 * member of — where that site is imported, so `/choose-editor` can open the
 * editor or offer a picker. Access is implicit: a site in an org the caller
 * isn't in simply doesn't appear. This asserts, over the wire:
 *
 *   - a member gets the project(s) in their own org(s);
 *   - the same site across two of the caller's orgs yields two matches;
 *   - a signed-in user who isn't a member sees nothing (empty, not 403);
 *   - an anonymous caller is refused (401);
 *   - a malformed slug fails cleanly (400).
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

interface ResolveResult {
  matches: {
    orgSlug: string;
    orgName: string;
    project: { id: string; title: string };
  }[];
}

async function createOrg(
  ctx: APIRequestContext,
  slug: string,
): Promise<string> {
  const res = await ctx.post("/api/auth/organization/create", {
    data: { name: slug, slug },
  });
  if (!res.ok()) {
    throw new Error(`createOrg ${slug}: HTTP ${res.status()}`);
  }
  const body = (await res.json()) as {
    slug?: string;
    data?: { slug?: string };
  };
  return body.slug ?? body.data?.slug ?? slug;
}

async function createProjectForSite(
  ctx: APIRequestContext,
  orgSlug: string,
  siteSlug: string,
): Promise<string> {
  const created = await callSelfMcpTool<{ item: { id: string } }>(
    ctx,
    orgSlug,
    "COLLECTION_VIRTUAL_MCP_CREATE",
    {
      data: {
        title: `Editor resolve e2e ${siteSlug}`,
        connections: [],
        metadata: { instructions: null, siteSlug },
      },
    },
  );
  return created.item.id;
}

test.describe("Editor resolve (choose-editor backend)", () => {
  test("resolves a site to the caller's projects across their orgs", async ({
    playwright,
  }) => {
    const ownerCtx = await newApiContext(playwright);
    const owner = await signUpViaApi(ownerCtx);
    const otherCtx = await newApiContext(playwright);
    await signUpViaApi(otherCtx);
    const anonCtx = await newApiContext(playwright);

    const suffix = `${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    const slug = `e2e-editor-${suffix}`;

    const project1 = await createProjectForSite(ownerCtx, owner.orgSlug, slug);

    // A second org the same user owns, with the same site imported.
    const org2Slug = await createOrg(ownerCtx, `e2e-org2-${suffix}`);
    const project2 = await createProjectForSite(ownerCtx, org2Slug, slug);

    const resolveUrl = (site: string) =>
      `/api/_editor-resolve?site=${encodeURIComponent(site)}`;

    // The caller sees the site in BOTH of their orgs.
    const ok = await ownerCtx.get(resolveUrl(slug));
    expect(ok.status()).toBe(200);
    const body = (await ok.json()) as ResolveResult;
    const byProject = new Map(body.matches.map((m) => [m.project.id, m]));
    expect(byProject.get(project1)?.orgSlug).toBe(owner.orgSlug);
    expect(byProject.get(project2)?.orgSlug).toBe(org2Slug);

    // Casing of the site name doesn't matter (slug is lowercased).
    const okUpper = await ownerCtx.get(resolveUrl(slug.toUpperCase()));
    expect(okUpper.status()).toBe(200);
    expect(((await okUpper.json()) as ResolveResult).matches.length).toBe(2);

    // A signed-in non-member sees nothing — empty, not 403 (no leak either).
    const other = await otherCtx.get(resolveUrl(slug));
    expect(other.status()).toBe(200);
    expect(((await other.json()) as ResolveResult).matches).toEqual([]);

    // Anonymous caller: refused.
    const anon = await anonCtx.get(resolveUrl(slug));
    expect(anon.status()).toBe(401);

    // Malformed slug → 400.
    const bad = await ownerCtx.get(resolveUrl("Not A Slug!"));
    expect(bad.status()).toBe(400);

    await ownerCtx.dispose();
    await otherCtx.dispose();
    await anonCtx.dispose();
  });
});
