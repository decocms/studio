/**
 * Editor-resolve route — `GET /api/_editor-resolve`.
 *
 * Powers the storefront "." shortcut: a live deco storefront redirects to
 * `studio.decocms.com/choose-editor?site=<name>&domain=<origin>&…`, and the
 * `/choose-editor` page calls this endpoint to map `(site, domain)` onto the
 * Studio project(s) whose content editor should open.
 *
 * Resolution is authoritative through `org_sites` (Studio's tenancy source of
 * truth): the storefront `site` name lowercased is the globally-unique site
 * slug, so one indexed read yields the owning org — no scanning the caller's
 * orgs. Membership is then enforced against the `member` table (a site the
 * caller can't access must not leak), and within that org we match Virtual MCPs
 * by `metadata.siteSlug` (primary) or `metadata.previewServerUrl` origin vs. the
 * storefront `domain` (fallback, covers custom domains). Instance-level: the org
 * is discovered here, not taken from the URL path.
 */

import { Hono } from "hono";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import {
  resolvePreviewServerUrl,
  sanitizeSiteUrl,
} from "@decocms/shared/deco-site-production-url";
import type { Env } from "../hono-env";
import { getUserId } from "@/core/studio-context";

/** The subset of a Virtual MCP the chooser UI renders. */
interface EditorProject {
  id: string;
  title: string;
  icon: string | null;
  previewServerUrl: string | null;
}

interface EditorResolveResult {
  orgSlug: string;
  projects: EditorProject[];
}

/** Origin (scheme://host[:port]) of a URL string, or null if unparseable. */
function originOf(value: string | null | undefined): string | null {
  const href = sanitizeSiteUrl(value);
  if (!href) return null;
  try {
    return new URL(href).origin;
  } catch {
    return null;
  }
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
    const domain = (c.req.query("domain") ?? "").trim();
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

    // Match by metadata.siteSlug (primary) and previewServerUrl origin (fallback).
    const vms = await ctx.storage.virtualMcps.list(orgId);
    const domainOrigin = originOf(domain);
    const bySlug = vms.filter(
      (vm) => vm.metadata?.siteSlug?.toLowerCase() === slug,
    );
    const byDomain = domainOrigin
      ? vms.filter(
          (vm) =>
            originOf(resolvePreviewServerUrl(vm.metadata)) === domainOrigin,
        )
      : [];
    // Union with slug matches first, de-duplicated by id.
    const seen = new Set<string>();
    const matched = [...bySlug, ...byDomain].filter((vm) => {
      if (seen.has(vm.id)) return false;
      seen.add(vm.id);
      return true;
    });

    if (matched.length === 0) {
      return c.json({ error: "No editor found for this site" }, 404);
    }

    const result: EditorResolveResult = {
      orgSlug: org.slug,
      projects: matched.map((vm) => ({
        id: vm.id,
        title: vm.title,
        icon: vm.icon ?? null,
        previewServerUrl: resolvePreviewServerUrl(vm.metadata),
      })),
    };
    return c.json(result);
  });

  return app;
}
