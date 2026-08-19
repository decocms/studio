/**
 * Editor-resolve route — `GET /api/_editor-resolve`.
 *
 * Powers the storefront "." shortcut: a live deco storefront redirects to
 * `studio.decocms.com/choose-editor?site=<name>&…`, and the `/choose-editor`
 * page calls this endpoint to find where the caller can open that site's
 * content editor.
 *
 * Resolution is relative to the authenticated user: the same storefront can be
 * imported into several orgs, so we scan the orgs the caller is a member of and
 * return every project whose `metadata.siteSlug` matches `site` (lowercased).
 * That makes access implicit (orgs the caller isn't in never appear — no leak,
 * no false 403) and lets `/choose-editor` offer a picker when the site lives in
 * more than one of the caller's orgs. Instance-level: no org in the URL path.
 *
 * NOT used: `org_sites` (its slug is a single global owner — an asset-bucket
 * tenancy concept, not "who can edit"), nor the storefront `domain` (it's the
 * live origin, while a project stores `previewServerUrl` — dev/preview server).
 */

import { Hono } from "hono";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";
import type { Env } from "../hono-env";
import { getUserId } from "@/core/studio-context";

/** One place the caller can open the site's editor: an (org, project) pair. */
interface EditorMatch {
  orgSlug: string;
  orgName: string;
  project: { id: string; title: string; icon: string | null };
}

interface EditorResolveResult {
  matches: EditorMatch[];
}

export function createEditorResolveRoutes() {
  const app = new Hono<Env>();

  app.get("/", async (c) => {
    const ctx = c.get("studioContext");

    // Instance-level route: guard auth ourselves (the page is auth-gated too).
    const userId = getUserId(ctx);
    if (!userId) {
      return c.json({ error: "Authentication required" }, 401);
    }

    const site = (c.req.query("site") ?? "").trim();
    const slug = site.toLowerCase();
    if (!isValidSiteSlug(slug)) {
      return c.json({ error: "Invalid site slug" }, 400);
    }

    // The caller's orgs (access is implicit — we never look outside them).
    const orgs = await ctx.db
      .selectFrom("member")
      .innerJoin("organization", "organization.id", "member.organizationId")
      .select([
        "organization.id as id",
        "organization.slug as slug",
        "organization.name as name",
        "organization.metadata as metadata",
      ])
      .where("member.userId", "=", userId)
      .execute();

    const matches: EditorMatch[] = [];
    for (const org of orgs) {
      if (!org.slug || isOrgArchived(org)) continue;
      const vms = await ctx.storage.virtualMcps.list(org.id);
      for (const vm of vms) {
        if (vm.metadata?.siteSlug?.toLowerCase() !== slug) continue;
        matches.push({
          orgSlug: org.slug,
          orgName: org.name ?? org.slug,
          project: { id: vm.id, title: vm.title, icon: vm.icon ?? null },
        });
      }
    }

    const result: EditorResolveResult = { matches };
    return c.json(result);
  });

  return app;
}
