/**
 * EXPERIMENT_RESULTS — A/B results for one experiment, read from the same
 * OneDollarStats backend Monitor uses. Ownership is checked against `org_sites`
 * so a member of org A can't read org B's site by guessing its slug.
 *
 * Returns `available: false` when the analytics backend isn't wired (local dev,
 * or a deployment without ONEDOLLAR_BACKEND_API_KEY) so the tab shows an
 * empty/unavailable state instead of a wrong zero. Port of the admin-mcp
 * `experiment_results` tool.
 */

import { z } from "zod";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { queryExperimentResults } from "../../deco-legacy/experiment-analytics";
import { resolveOwnedAnalyticsSite } from "./ownership";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Default window: the last 30 calendar dates, inclusive. */
function defaultWindow(): { since: string; until: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 29);
  return { since: toIsoDate(start), until: toIsoDate(end) };
}

export const EXPERIMENT_RESULTS = defineTool({
  name: "EXPERIMENT_RESULTS",
  description:
    "A/B results for one experiment: per-goal visitor conversions for each variant, a daily timeseries for the selected goal, and the computed statistics (participants, target sample size, probability each variant is best).",
  annotations: {
    title: "Experiment Results",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: z.object({
    site: z
      .string()
      .min(1)
      .max(60)
      .refine(isValidSiteSlug)
      .describe("Site slug the experiment belongs to."),
    key: z
      .string()
      .min(1)
      .describe(
        "Analytics prop key the variants split on: `event:props:<key>` = 'true'/'false'. In the deco runtime this is the sticky segment matcher block's id (not the multivariate section name), so `key` must equal that matcher id for results to populate.",
      ),
    since: z
      .string()
      .regex(ISO_DATE)
      .optional()
      .describe("Window start (YYYY-MM-DD)."),
    until: z
      .string()
      .regex(ISO_DATE)
      .optional()
      .describe("Window end (YYYY-MM-DD)."),
    goals: z
      .array(z.string())
      .default([])
      .describe("Custom goals to aggregate conversions for."),
    goalOnDash: z
      .string()
      .default("visitors")
      .describe("Goal plotted in the timeseries / used for the statistics."),
  }),
  outputSchema: z.object({
    available: z.boolean(),
    /** Why `results` is null: the deployment has no analytics backend, or it
     *  does but this site reports no traffic (e.g. a migrated site whose
     *  analytics live under another slug — see `analyticsSiteSlug`). */
    reason: z.enum(["not_configured", "no_site_data"]).nullable(),
    /** The site slug analytics was actually read for (the override, if any). */
    analyticsSite: z.string(),
    results: z
      .object({
        visitors: z.object({ default: z.number(), variant: z.number() }),
        goals: z.array(
          z.object({
            goal: z.string(),
            default: z.number(),
            variant: z.number(),
          }),
        ),
        timeseries: z.array(
          z.object({
            date: z.string(),
            default: z.number(),
            variant: z.number(),
          }),
        ),
        stats: z.object({
          totalParticipants: z.number(),
          sampleSize: z.number(),
          probabilityVariantBest: z.number(),
          probabilityDefaultBest: z.number(),
        }),
      })
      .nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const slug = await resolveOwnedAnalyticsSite(
      ctx,
      organization.id,
      input.site,
    );

    const window =
      input.since && input.until
        ? { since: input.since, until: input.until }
        : defaultWindow();

    const outcome = await queryExperimentResults({
      slug,
      testName: input.key,
      since: window.since,
      until: window.until,
      goals: input.goals,
      goalOnDash: input.goalOnDash,
    });

    return outcome.status === "ok"
      ? {
          available: true,
          reason: null,
          analyticsSite: slug,
          results: outcome.results,
        }
      : {
          available: false,
          reason: outcome.status,
          analyticsSite: slug,
          results: null,
        };
  },
});
