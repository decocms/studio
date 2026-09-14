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

const NOTICE_SOURCE = "decommand_ar";
const NOTICE_ACTOR = "service:decommand-center";
export const ORGANIZATION_NOTICES_API_PREFIX = "/api/_organization-notices";

type Variables = {
  studioContext: StudioContext;
};

/** Keep organization-notice access separate from credential vault access. */
export function isOrganizationNoticesApiKey(token: string): boolean {
  const expected = process.env.ORGANIZATION_NOTICES_API_KEY;
  return !!expected && safeEqual(token, expected);
}

export const organizationNoticeSiteResolutionBodySchema = z.object({
  siteSlugs: z
    .array(z.string().trim().toLowerCase())
    .min(1)
    .max(500)
    .transform((items) => [...new Set(items)])
    .refine((items) => items.every(isValidSiteSlug), {
      message: "Every site slug must be a valid Studio site slug",
    }),
});

async function requireOrganizationNoticesApiKey(
  c: Context<{ Variables: Variables }>,
  next: Next,
) {
  const token = bearerToken(c.req.header("authorization"));
  if (!token || !isOrganizationNoticesApiKey(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  return next();
}

function auditOrganizationNotice(
  action: "set" | "resolve" | "refused",
  props: Record<string, unknown>,
) {
  console.log("organization_notice_service_action", { action, ...props });
}

/**
 * Service-to-service control for the same organization notice rendered by the
 * Studio shell. The source is fixed server-side: deCommand can update or clear
 * only notices it created and can never overwrite a deployment-admin notice.
 */
export const createOrganizationNoticeServiceRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();

  app.use("/internal/organization-notices", requireOrganizationNoticesApiKey);

  app.get("/internal/organization-notices", async (c) => {
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

  app.put("/internal/organization-notices", async (c) => {
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
      source: NOTICE_SOURCE,
      by: NOTICE_ACTOR,
    });
    if (!notice) {
      const active = await storage.getActive(organizationId);
      auditOrganizationNotice("refused", {
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
    auditOrganizationNotice("set", {
      organization_id: organizationId,
      severity: notice.severity,
      source: NOTICE_SOURCE,
    });
    posthog.capture({
      distinctId: NOTICE_ACTOR,
      event: "organization_notice_service_set",
      groups: { organization: organizationId },
      properties: {
        organization_id: organizationId,
        severity: notice.severity,
        source: NOTICE_SOURCE,
      },
    });
    return c.json({ notice });
  });

  app.delete("/internal/organization-notices", async (c) => {
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
    if (active.source !== NOTICE_SOURCE) {
      auditOrganizationNotice("refused", {
        organization_id: organizationId,
        active_source: active.source,
        reason: "active_notice_owned_by_another_source",
      });
      return c.json(
        {
          error:
            "This notice belongs to another source and cannot be resolved by this service",
          notice: active,
        },
        409,
      );
    }

    const resolved = await storage.resolveActiveForSource({
      organizationId,
      source: NOTICE_SOURCE,
      by: NOTICE_ACTOR,
    });
    if (!resolved) {
      return c.json(
        { error: "The active notice changed before it could be resolved" },
        409,
      );
    }

    invalidateOrgNoticeCache(organizationId);
    auditOrganizationNotice("resolve", {
      organization_id: organizationId,
      source: NOTICE_SOURCE,
    });
    posthog.capture({
      distinctId: NOTICE_ACTOR,
      event: "organization_notice_service_resolved",
      groups: { organization: organizationId },
      properties: {
        organization_id: organizationId,
        source: NOTICE_SOURCE,
      },
    });
    return c.json({ ok: true });
  });

  return app;
};

/**
 * Cross-organization read used to map deCommand subscription repositories to
 * their Studio organizations in one request. `org_sites` is the ownership
 * source of truth; the dedicated API key is the only principal allowed.
 */
export const createOrganizationNoticeSiteResolutionRoutes = () => {
  const app = new Hono<{ Variables: Variables }>();
  app.use("*", requireOrganizationNoticesApiKey);

  app.post("/site-organizations", async (c) => {
    const parsed = organizationNoticeSiteResolutionBodySchema.safeParse(
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
