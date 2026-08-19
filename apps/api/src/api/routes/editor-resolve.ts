/**
 * Editor-resolve route — `GET /api/_editor-resolve`.
 *
 * Powers the storefront "." shortcut: a live deco storefront redirects to
 * `studio.decocms.com/choose-editor?site=<name>&…`, and the `/choose-editor`
 * page calls this endpoint to map `site` onto the Studio project(s) whose
 * content editor should open.
 *
 * Resolution is authoritative through `org_sites` (Studio's tenancy source of
 * truth): the storefront `site` name lowercased is the globally-unique site
 * slug, so one indexed read yields the owning org — no scanning the caller's
 * orgs. Membership is then enforced against the `member` table (a site the
 * caller can't access must not leak), and within that org we match Virtual MCPs
 * by `metadata.siteSlug` (== `site` lowercased — the same deterministic key).
 * The storefront `domain` is intentionally NOT used to match: it's the live
 * storefront origin, whereas a project stores `previewServerUrl` (the dev/
 * preview server, often staging or localhost), so the two rarely coincide.
 * Instance-level: the org is discovered here, not taken from the URL path.
 */

import { Hono } from "hono";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import type { Env } from "../hono-env";
import { getUserId } from "@/core/studio-context";

/** The subset of a Virtual MCP the chooser UI renders. */
interface EditorProject {
  id: string;
  title: string;
  icon: string | null;
}

interface EditorResolveResult {
  orgSlug: string;
  projects: EditorProject[];
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

    // Site name → owning org (globally-unique slug, one indexed read).
    const orgSite = await ctx.storage.orgSites.getBySlug(slug);
    if (!orgSite) {
      return c.json({ error: "Site is not linked to any Studio project" }, 404);
    }
    const orgId = orgSite.organizationId;

    // Enforce membership so a non-member can't learn which org owns the site.
    const membership = await ctx.db
      .selectFrom("member")
      .select(["role"])
      .where("userId", "=", userId)
      .where("organizationId", "=", orgId)
      .executeTakeFirst();
    if (!membership) {
      return c.json({ error: "You don't have access to this site" }, 403);
    }

    // org id → slug (the editor URL is keyed by slug).
    const org = await ctx.db
      .selectFrom("organization")
      .select(["id", "slug"])
      .where("id", "=", orgId)
      .executeTakeFirst();
    if (!org?.slug) {
      return c.json({ error: "Organization not found" }, 404);
    }

    // Match projects by metadata.siteSlug (== site lowercased).
    const vms = await ctx.storage.virtualMcps.list(orgId);
    const matched = vms.filter(
      (vm) => vm.metadata?.siteSlug?.toLowerCase() === slug,
    );

    if (matched.length === 0) {
      return c.json({ error: "No editor found for this site" }, 404);
    }

    const result: EditorResolveResult = {
      orgSlug: org.slug,
      projects: matched.map((vm) => ({
        id: vm.id,
        title: vm.title,
        icon: vm.icon ?? null,
      })),
    };
    return c.json(result);
  });

  return app;
}
