import { Hono, type Context, type Next } from "hono";
import { z } from "zod";
import { OrgNoticeInputSchema } from "@decocms/shared/organization/notice";
import { isOrgArchived } from "@decocms/shared/organization/org-archived";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import type { StudioContext } from "@/core/studio-context";
import { invalidateOrgNoticeCache } from "@/core/org-notice-gate";
import { posthog } from "@/posthog";
import { OrganizationNoticeStorage } from "@/storage/organization-notices";
import { bearerToken, safeEqual } from "./credential-vault";

const FINANCE_NOTICE_SOURCE = "finance_ar";
const FINANCE_NOTICE_ACTOR = "service:decommand-center";
export const FINANCE_API_PREFIX = "/api/_finance";

type Variables = {
  studioContext: StudioContext;
};

/** A dedicated token keeps finance notice access separate from credential vault access. */
export function isFinanceServiceToken(token: string): boolean {
  const expected = process.env.FINANCE_SERVICE_TOKEN;
  return !!expected && safeEqual(token, expected);
}

export const financeSiteResolutionBodySchema = z.object({
  siteSlugs: z
    .array(z.string().trim().toLowerCase())
    .min(1)
    .max(500)
    .transform((items) => [...new Set(items)])
    .refine((items) => items.every(isValidSiteSlug), {
      message: "Every site slug must be a valid Studio site slug",
    }),
});

async function requireFinanceServiceToken(
  c: Context<{ Variables: Variables }>,
  next: Next,
) {
  const token = bearerToken(c.req.header("authorization"));
  if (!token || !isFinanceServiceToken(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
}

function auditFinanceNotice(
  action: "set" | "resolve" | "refused",
  props: Record<string, unknown>,
) {
  console.log("finance_ar_notice_action", { action, ...props });
}

/**
 * Service-to-service control for the same organization notice rendered by the
 * Studio shell. The source is fixed server-side: deCommand can update or clear
 * only notices it created and can never overwrite a deployment-admin notice.
 */
export const createFinanceNoticeRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.use("/internal/finance/notice", async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    if (!token || !isFinanceServiceToken(token)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return next();
  });

  app.get("/internal/finance/notice", async (c) => {
    const ctx = c.get("studioContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }
    const notice = await new OrganizationNoticeStorage(ctx.db).getActive(
      organizationId,
    );
    return c.json({ notice });
  });

  app.put("/internal/finance/notice", async (c) => {
    const parsed = OrgNoticeInputSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid notice", issues: parsed.error.issues },
        400,
      );
    }

    const ctx = c.get("studioContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    const storage = new OrganizationNoticeStorage(ctx.db);
    const notice = await storage.setActiveForSource({
      organizationId,
      notice: parsed.data,
      source: FINANCE_NOTICE_SOURCE,
      by: FINANCE_NOTICE_ACTOR,
    });
    if (!notice) {
      const active = await storage.getActive(organizationId);
      auditFinanceNotice("refused", {
        organization_id: organizationId,
        requested_severity: parsed.data.severity,
        active_source: active?.source ?? null,
        reason: "active_notice_owned_by_another_source",
      });
      return c.json(
        {
          error:
            "An active notice from another source must be cleared by a deployment admin",
          notice: active,
        },
        409,
      );
    }

    invalidateOrgNoticeCache(organizationId);
    auditFinanceNotice("set", {
      organization_id: organizationId,
      severity: notice.severity,
      source: FINANCE_NOTICE_SOURCE,
    });
    posthog.capture({
      distinctId: FINANCE_NOTICE_ACTOR,
      event: "finance_ar_org_notice_set",
      groups: { organization: organizationId },
      properties: {
        organization_id: organizationId,
        severity: notice.severity,
        source: FINANCE_NOTICE_SOURCE,
      },
    });
    return c.json({ notice });
  });

  app.delete("/internal/finance/notice", async (c) => {
    const ctx = c.get("studioContext");
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 403);
    }

    const storage = new OrganizationNoticeStorage(ctx.db);
    const active = await storage.getActive(organizationId);
    if (!active) {
      return c.json({ error: "No active notice for this organization" }, 404);
    }
    if (active.source !== FINANCE_NOTICE_SOURCE) {
      auditFinanceNotice("refused", {
        organization_id: organizationId,
        active_source: active.source,
        reason: "active_notice_owned_by_another_source",
      });
      return c.json(
        {
          error:
            "This notice belongs to another source and cannot be resolved by finance",
          notice: active,
        },
        409,
      );
    }

    const resolved = await storage.resolveActiveForSource({
      organizationId,
      source: FINANCE_NOTICE_SOURCE,
      by: FINANCE_NOTICE_ACTOR,
    });
    if (!resolved) {
      return c.json(
        { error: "The active notice changed before it could be resolved" },
        409,
      );
    }

    invalidateOrgNoticeCache(organizationId);
    auditFinanceNotice("resolve", {
      organization_id: organizationId,
      source: FINANCE_NOTICE_SOURCE,
    });
    posthog.capture({
      distinctId: FINANCE_NOTICE_ACTOR,
      event: "finance_ar_org_notice_resolved",
      groups: { organization: organizationId },
      properties: {
        organization_id: organizationId,
        source: FINANCE_NOTICE_SOURCE,
      },
    });
    return c.json({ ok: true });
  });

  return app;
};

/**
 * Cross-organization read used to map deCommand subscription repositories to
 * their Studio organizations in one request. `org_sites` is the ownership
 * source of truth; the dedicated finance token is the only principal allowed.
 */
export const createFinanceSiteResolutionRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", requireFinanceServiceToken);

  app.post("/site-organizations", async (c) => {
    const parsed = financeSiteResolutionBodySchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid site list", issues: parsed.error.issues },
        400,
      );
    }

    const ctx = c.get("studioContext");
    const rows = await ctx.db
      .selectFrom("org_sites")
      .innerJoin("organization", "organization.id", "org_sites.organization_id")
      .select([
        "org_sites.slug as siteSlug",
        "organization.id as organizationId",
        "organization.slug as organizationSlug",
        "organization.name as organizationName",
        "organization.metadata as organizationMetadata",
      ])
      .where("org_sites.slug", "in", parsed.data.siteSlugs)
      .execute();

    const activeRows = rows.filter(
      (row) =>
        row.organizationSlug &&
        !isOrgArchived({ metadata: row.organizationMetadata }),
    );
    const notices = await new OrganizationNoticeStorage(
      ctx.db,
    ).getActiveForOrgs(activeRows.map((row) => row.organizationId));

    return c.json({
      sites: activeRows.map((row) => ({
        siteSlug: row.siteSlug,
        organizationId: row.organizationId,
        organizationSlug: row.organizationSlug,
        organizationName: row.organizationName,
        notice: notices.get(row.organizationId) ?? null,
      })),
    });
  });

  return app;
};
