/**
 * The store the Plan engine analyses: its profile, and finding it among the
 * organization's site projects.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import type { StudioContext } from "@/core/studio-context";
import { normalizeDomain } from "@/plan-engine/benchmark";
import { checkDomain, sameStore } from "@/plan-engine/domain-check";
import { orgHeatmap } from "@/plan-engine/adapters/analytics";
import type { HeatmapReader } from "@/plan-engine/ports";
import { detectSiteSources } from "@/plan-engine/site-sources";
import {
  findAnalyticsSite,
  projectConfirmsStore,
  type StudioProject,
  toStudioProject,
  type VirtualMcpItem,
} from "@/plan-engine/studio-project";
import type { SiteProfile, SiteSources } from "@/plan-engine/types";
import { nowIso } from "@/storage/plan-engine";
import {
  engineOrg,
  engineOutput,
  errorOf,
  READ,
  RejectedSchema,
  Row,
  WRITE,
  withOrgMediaUrls,
} from "./gate";

type Rejected = { domain: string; reason: string };

/** "owner/name" → parts; null when malformed. */
function parseRepo(s: string): { owner: string; name: string } | null {
  const m = s.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null;
}

/** The first of the org's site projects Deco Analytics already knows; null when none, or when reading fails. */
async function analyticsSiteAmong(
  heatmap: HeatmapReader,
  org: { slug: string },
  items: readonly VirtualMcpItem[],
  opts: { domain: string },
): Promise<string | null> {
  const projects = items
    .map(toStudioProject)
    .filter((p): p is StudioProject => p !== null);
  return await findAnalyticsSite(
    projects,
    async (slug) =>
      (await heatmap(slug, { page: "/", device: "mobile", range: "7d" }))
        .registered,
    { orgSlug: org.slug, domain: opts.domain },
  ).catch(() => null);
}

/**
 * Finds the store among the org's site projects and fills what the profile
 * lacks, never what someone edited by hand. Without a profile or a domain on
 * any project, `profile` is null and the page asks for the domain. A failed
 * read keeps what an earlier one found.
 */
export async function syncProfileFromStudio(
  ctx: StudioContext,
  org: { id: string; slug: string },
  heatmap: HeatmapReader = orgHeatmap(ctx),
): Promise<{ profile: SiteProfile | null; sources: SiteSources | null }> {
  const store = ctx.storage.planEngine;
  const current = await store.getSiteProfile(org.id);
  let items: Promise<VirtualMcpItem[]> | null = null;
  const listProjects = () => {
    items ??= ctx.storage.virtualMcps.list(org.id).then((list) =>
      list.map(
        (v): VirtualMcpItem => ({
          id: v.id,
          title: v.title,
          metadata: v.metadata as VirtualMcpItem["metadata"],
        }),
      ),
    );
    return items;
  };
  const detected = await detectSiteSources({
    projects: listProjects,
    orgSlug: org.slug,
    domain: current?.domain ?? null,
    now: nowIso(),
  });
  const { project } = detected;
  const prev = current?.sources ?? null;
  const sources: SiteSources = {
    ...detected.sources,
    studio_project:
      detected.sources.studio_project ?? prev?.studio_project ?? null,
    // A project read without a repository means no repository.
    repository: project
      ? detected.sources.repository
      : (prev?.repository ?? null),
  };
  let profile = current;
  if (!profile && project?.domain) {
    profile = await store.upsertSiteProfile(org.id, {
      domain: project.domain,
      studio_site: project.site_slug,
    });
  } else if (profile && project) {
    // Same store on another host: production's wins.
    const canonical =
      project.domain &&
      project.domain !== profile.domain &&
      sameStore(project.domain, profile.domain)
        ? project.domain
        : undefined;
    // The project's slug only when its domain proves it is this store.
    let site =
      profile.studio_site === null &&
      projectConfirmsStore(project, canonical ?? profile.domain)
        ? project.site_slug
        : undefined;
    // Projects without a production domain prove nothing, but the one Analytics already knows is the store.
    if (profile.studio_site === null && !site) {
      site =
        (await analyticsSiteAmong(heatmap, org, await listProjects(), {
          domain: canonical ?? profile.domain,
        })) ?? undefined;
    }
    if (canonical || site) {
      profile = await store.upsertSiteProfile(org.id, {
        domain: canonical,
        studio_site: site,
      });
    }
  }
  if (profile) {
    await store.saveSiteSources(org.id, sources);
    profile = { ...profile, sources };
  }
  return { profile, sources };
}

export const PLAN_UX_SITE_PROFILE_GET = defineTool({
  name: "PLAN_UX_SITE_PROFILE_GET",
  description:
    "The store the Plan page's diagnosis analyses: domain, analytics site, competitors and the design system read from it. `profile` is null until the store is known.",
  annotations: { title: "Get Store Profile", ...READ },
  inputSchema: z.object({}),
  outputSchema: engineOutput(z.object({ profile: Row.nullable() })),
  handler: async (_input, ctx) => {
    const org = await engineOrg(ctx);
    try {
      return await withOrgMediaUrls(ctx, {
        profile: await ctx.storage.planEngine.getSiteProfile(org.id),
      });
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_SITE_PROFILE_UPDATE = defineTool({
  name: "PLAN_UX_SITE_PROFILE_UPDATE",
  description:
    "Create or update the store profile of the Plan page's diagnosis. `domain` is required the first time. Competitors are each checked before saving: one that does not answer refuses the whole list, and a saved list is confirmed, so runs keep it.",
  annotations: { title: "Update Store Profile", ...WRITE },
  inputSchema: z.object({
    domain: z
      .string()
      .optional()
      .describe("Public domain, e.g. www.store.example"),
    studio_site: z
      .string()
      .nullable()
      .optional()
      .describe("The store's analytics site slug (empty = the org's slug)"),
    pdp_path_template: z
      .string()
      .optional()
      .describe("The product page route in analytics, e.g. /:product/p"),
    competitors: z
      .array(z.string())
      .max(10)
      .optional()
      .describe(
        "Up to 10 competitor domains. Each is checked before saving; the saved list is confirmed. Empty = the next run suggests again",
      ),
    code_project_id: z
      .string()
      .nullable()
      .optional()
      .describe("The site's Studio project (vir_…). null turns it off"),
    code_repo: z
      .string()
      .nullable()
      .optional()
      .describe('The site\'s repository, "owner/name". null turns it off'),
  }),
  outputSchema: engineOutput(
    z.object({ profile: Row, warnings: z.array(RejectedSchema).optional() }),
  ),
  handler: async (input, ctx) => {
    const org = await engineOrg(ctx);
    let domain: string | undefined;
    if (input.domain !== undefined) {
      const normalized = normalizeDomain(input.domain);
      if (!normalized) return { error: `domínio inválido: ${input.domain}` };
      domain = normalized;
    }
    const invalidCompetitors: Rejected[] = [];
    const competitorInput: string[] = [];
    for (const raw of input.competitors ?? []) {
      const normalized = normalizeDomain(raw);
      if (normalized) competitorInput.push(normalized);
      else invalidCompetitors.push({ domain: raw, reason: "domínio inválido" });
    }
    const template = input.pdp_path_template?.trim();
    if (template !== undefined && !template.startsWith("/")) {
      return { error: "o template da PDP precisa começar com /" };
    }
    const codeRepo =
      input.code_repo === undefined
        ? undefined
        : input.code_repo?.trim() || null;
    if (codeRepo && !parseRepo(codeRepo)) {
      return { error: `repo inválido (use owner/nome): ${codeRepo}` };
    }
    const codeProjectId =
      input.code_project_id === undefined
        ? undefined
        : input.code_project_id?.trim() || null;
    if (codeProjectId && !/^vir_[\w-]+$/.test(codeProjectId)) {
      return { error: `projeto inválido (use o id vir_…): ${codeProjectId}` };
    }
    let competitors: string[] | undefined;
    const warnings: Rejected[] = [];
    if (input.competitors !== undefined) {
      const checks = await Promise.all(
        [...new Set(competitorInput)].map((d) => checkDomain(d)),
      );
      const rejected = [
        ...invalidCompetitors,
        ...checks.flatMap((c) =>
          c.ok ? [] : [{ domain: c.domain, reason: c.reason }],
        ),
      ];
      if (rejected.length > 0) {
        return { error: "alguns concorrentes não responderam", rejected };
      }
      // www.x and x can land on the same host: saved once.
      const seen = new Set<string>();
      competitors = [];
      for (const c of checks) {
        if (!c.ok || seen.has(c.host)) continue;
        seen.add(c.host);
        competitors.push(c.host);
        if (c.blocks_bots) {
          warnings.push({
            domain: c.host,
            reason: "bloqueia navegador automático",
          });
        }
      }
    }
    try {
      const profile = await ctx.storage.planEngine.upsertSiteProfile(org.id, {
        domain,
        studio_site:
          input.studio_site === undefined
            ? undefined
            : input.studio_site?.trim() || null,
        pdp_path_template: template || undefined,
        competitors,
        competitors_confirmed:
          competitors === undefined ? undefined : competitors.length > 0,
        code_repo: codeRepo,
        code_project_id: codeProjectId,
      });
      return await withOrgMediaUrls(ctx, {
        profile,
        ...(warnings.length > 0 ? { warnings } : {}),
      });
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});

export const PLAN_UX_SITE_SOURCES_DETECT = defineTool({
  name: "PLAN_UX_SITE_SOURCES_DETECT",
  description:
    "Find the store among the organization's site projects (production domain, analytics site, repository) and fill the diagnosis profile with what it lacks. Never overwrites what was edited by hand.",
  annotations: { title: "Detect Store Sources", ...WRITE },
  inputSchema: z.object({}),
  outputSchema: engineOutput(
    z.object({ profile: Row.nullable(), sources: Row.nullable() }),
  ),
  handler: async (_input, ctx) => {
    const org = await engineOrg(ctx);
    try {
      return await withOrgMediaUrls(ctx, await syncProfileFromStudio(ctx, org));
    } catch (err) {
      return { error: errorOf(err) };
    }
  },
});
