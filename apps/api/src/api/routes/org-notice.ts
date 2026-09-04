/**
 * The notice a member of the organization reads: `GET /api/:org/notice`.
 *
 * Membership is already enforced by `resolveOrgFromPath`, and the response is
 * the tenant-facing slice only — who pinned the notice and when is operator
 * data that stays in the admin surface.
 *
 * The shell fetches this on boot to decide between a banner (`warn`) and the
 * block screen (`block`), so it must stay readable while the org is blocked —
 * a GET, which the block gate never touches.
 */

import { Hono } from "hono";
import type { OrgNoticePublic } from "@decocms/shared/organization/notice";
import { getActiveOrgNoticeCached } from "../../core/org-notice-gate";
import type { Env } from "../hono-env";

export const createOrgNoticeRoutes = () => {
  const app = new Hono<Env>();

  app.get("/notice", async (c) => {
    const ctx = c.get("studioContext");
    const organizationId = ctx?.organization?.id;
    if (!organizationId) {
      return c.json({ error: "Organization context required" }, 400);
    }

    const notice = await getActiveOrgNoticeCached(ctx.db, organizationId);
    const publicNotice: OrgNoticePublic | null = notice
      ? {
          severity: notice.severity,
          title: notice.title,
          message: notice.message,
          ctaLabel: notice.ctaLabel,
          ctaUrl: notice.ctaUrl,
        }
      : null;

    return c.json({ notice: publicNotice });
  });

  return app;
};
