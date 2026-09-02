/**
 * User-scoped API — the caller's data across every org they belong to.
 */

import { Hono } from "hono";
import { isDecopilot, isStudioPackAgent } from "@decocms/shared/sdk";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";
import { getApiKeyOrganizationBinding } from "../middleware/resolve-org-from-path";
import { getUserId, type StudioContext } from "@/core/studio-context";
import type { CrossOrgProjectMatch } from "@/storage/virtual";

export const ME_API_PREFIX = "/api/_me";

type MeEnv = { Variables: { studioContext: StudioContext } };

/** Rows the picker must never offer. Each test is per-row, so the predicate
 *  survives a search that spans organizations — unlike the web client's dev
 *  filter, which infers "is a dev agent" by scanning one org's whole list and
 *  therefore cannot run over a cross-org result set. */
function isPlumbing(match: CrossOrgProjectMatch): boolean {
  if (isDecopilot(match.id) !== null) return true;
  if (isStudioPackAgent(match.id)) return true;
  const liveAgentId = match.metadata?.liveAgentId;
  return typeof liveAgentId === "string" && liveAgentId.length > 0;
}

/**
 * Drops rows from organizations whose SSO the caller has not completed.
 */
function createSsoGate(ctx: StudioContext, userId: string) {
  const verdicts = new Map<string, Promise<boolean>>();

  const isAllowed = (orgId: string): Promise<boolean> => {
    const cached = verdicts.get(orgId);
    if (cached) return cached;
    const verdict = (async () => {
      const config = await ctx.storage.orgSsoConfig.getByOrgId(orgId);
      if (!config?.enforced) return true;
      return await ctx.storage.orgSsoSessions.isValid(userId, orgId);
    })();
    verdicts.set(orgId, verdict);
    return verdict;
  };

  return async <T extends { orgId: string }>(rows: T[]): Promise<T[]> => {
    const allowed = await Promise.all(rows.map((row) => isAllowed(row.orgId)));
    return rows.filter((_, index) => allowed[index] === true);
  };
}

/**
 * The one organization a credential-authenticated caller may read, or `null`
 * for a session user, who may read every organization they belong to.
 */
export const DENY = Symbol("deny");
export function credentialOrganizationFence(
  ctx: StudioContext,
): string | null | typeof DENY {
  const binding = ctx.auth?.apiKey?.id
    ? getApiKeyOrganizationBinding(ctx)
    : { present: false as const, id: undefined };
  if (binding.present && !binding.id) return DENY;

  const token = ctx.auth?.tokenOrganizationId;
  if (binding.id && token && binding.id !== token) return DENY;
  return binding.id ?? token ?? null;
}

/** Enough to draw a row and navigate to it. */
interface ProjectSearchHit {
  id: string;
  title: string;
  icon: string | null;
  orgId: string;
  orgName: string;
  orgSlug: string;
}

/** The picker shows a short list; a bigger page would only widen the scan. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;
/** Over-fetch so rows dropped below don't shorten the visible page. */
const FILTER_HEADROOM = 10;
/** Headroom alone truncated the answer whenever more rows than that were
 *  hidden (plumbing, archived, SSO), so the handler pages on until the page is
 *  full — bounded, so a term matching mostly hidden rows costs a fixed number
 *  of queries rather than a scan. */
const MAX_PAGES = 5;

export const createMeRoutes = () => {
  const app = new Hono<MeEnv>();

  /**
   * `GET /api/_me/projects/search?q=<term>&limit=<n>` Projects matching `q`
   * across every organization the caller belongs to.
   */
  app.get("/projects/search", async (c) => {
    const ctx = c.get("studioContext");
    // Per-caller results: no intermediary may reuse them for another session.
    c.header("Cache-Control", "private, no-store");

    // An API-key caller has no `auth.user`, but the key names its owner.
    const userId = getUserId(ctx);
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const fence = credentialOrganizationFence(ctx);
    if (fence === DENY) {
      return c.json(
        { error: "forbidden: credential is scoped to another organization" },
        403,
      );
    }

    const term = (c.req.query("q") ?? "").trim();
    if (!term) {
      return c.json({ items: [] as ProjectSearchHit[] });
    }

    const requested = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const dropSsoBlockedOrgs = createSsoGate(ctx, userId);
    const pageSize = limit + FILTER_HEADROOM;
    const hits: ProjectSearchHit[] = [];

    for (let page = 0; page < MAX_PAGES && hits.length < limit; page++) {
      const matches = await ctx.storage.virtualMcps.searchAcrossMemberships({
        userId,
        term,
        limit: pageSize,
        offset: page * pageSize,
        organizationId: fence,
      });

      const visible: ProjectSearchHit[] = matches
        .filter((match) => !isPlumbing(match))
        .filter(
          (match) => !isOrgArchived({ metadata: match.organization_metadata }),
        )
        .map((match) => ({
          id: match.id,
          title: match.title,
          icon: match.icon,
          orgId: match.organization_id,
          orgName: match.organization_name,
          orgSlug: match.organization_slug,
        }));

      hits.push(...(await dropSsoBlockedOrgs(visible)));

      // Short page: the query is exhausted, so paging on reads nothing.
      if (matches.length < pageSize) break;
    }

    return c.json({ items: hits.slice(0, limit) });
  });

  return app;
};
