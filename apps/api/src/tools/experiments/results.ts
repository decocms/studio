/**
 * EXPERIMENT_RESULTS — A/B results for one experiment, read from the same
 * OneDollarStats backend Monitor uses. Ownership is checked against `org_sites`
 * so a member of org A can't read org B's site by guessing its slug.
 *
 * When that backend has nothing (not wired, or no traffic for the site), the
 * site's Deco Analytics answers instead, if the org can read its registration
 * (`source: "deco-analytics"`). Returns `available: false` when neither has it,
 * so the tab shows an empty/unavailable state instead of a wrong zero. Port of
 * the admin-mcp `experiment_results` tool.
 */

import { z } from "zod";
import { isValidSiteSlug } from "@decocms/shared/site-slug";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { queryExperimentResults } from "../../deco-legacy/experiment-analytics";
import { readDecoExperimentResults } from "../../analytics/experiment-results";
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
  inputSchema: z
    .object({
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
        .array(z.string().min(1).max(200))
        .max(20)
        .default([])
        .describe("Custom goals to aggregate conversions for."),
      goalOnDash: z
        .string()
        .default("visitors")
        .describe("Goal plotted in the timeseries / used for the statistics."),
    })
    .refine((v) => !v.since || !v.until || v.since <= v.until, {
      message: "`since` must not be after `until`",
      path: ["since"],
    }),
  outputSchema: z.object({
    available: z.boolean(),
    /** Why `results` is null: the deployment has no analytics backend, or it
     *  does but this site reports no traffic (e.g. a migrated site whose
     *  analytics live under another slug — see `analyticsSiteSlug`). */
    reason: z.enum(["not_configured", "no_site_data"]).nullable(),
    /** The site slug analytics was actually read for (the override, if any). */
    analyticsSite: z.string(),
    /** Which backend answered; absent when none did. */
    source: z.enum(["legacy", "deco-analytics"]).optional(),
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
          /** Null while either arm has no visitors or no conversions. */
          probabilityVariantBest: z.number().nullable(),
          probabilityDefaultBest: z.number().nullable(),
        }),
        /** Deco Analytics only: the goal the statistics compare. */
        statsGoal: z.string().optional(),
        /** Deco Analytics only: every configured arm, zeros when it has no
         *  data. `exposed` is null without an exposure event among the goals. */
        arms: z
          .array(
            z.object({
              id: z.string(),
              visitors: z.number(),
              /** Converters on `statsGoal` among every visitor. */
              converters: z.number(),
              exposed: z.number().nullable(),
              convertersAmongExposed: z.number().nullable(),
              purchases: z.number(),
              revenue: z.number(),
              behaviour: z
                .object({
                  pageviewsPerVisitor: z.number(),
                  activeSecondsPerVisitor: z.number(),
                  clicksPerVisitor: z.number(),
                  medianScrollDepth: z.number(),
                  errorPct: z.number(),
                })
                .nullable(),
              /** Per UTC day, oldest first: the same counts as the arm. */
              daily: z.array(
                z.object({
                  date: z.string(),
                  visitors: z.number(),
                  exposed: z.number().nullable(),
                  converters: z.number(),
                  convertersAmongExposed: z.number().nullable(),
                }),
              ),
            }),
          )
          .optional(),
        /** Deco Analytics only: the currency revenue is in, when named. */
        currency: z.string().nullable().optional(),
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

    if (outcome.status === "ok") {
      return {
        available: true,
        reason: null,
        analyticsSite: slug,
        source: "legacy" as const,
        results: outcome.results,
      };
    }

    const unavailable = {
      available: false,
      reason: outcome.status,
      analyticsSite: slug,
      results: null,
    };
    const experiment = await ctx.storage.experiments
      .getByKey(organization.id, input.site, input.key)
      .catch((err) => {
        console.error(
          `[experiments] experiment lookup failed for site="${input.site}":`,
          err,
        );
        return null;
      });
    // Without the configured arms, control and treatment would follow the
    // payload's row order, which is not guaranteed.
    if (!experiment?.variants.length) return unavailable;
    const deco = await readDecoExperimentResults(ctx, organization.id, {
      slug,
      key: input.key,
      goals: [...input.goals, ...experiment.goals],
      goalOnDash: input.goalOnDash,
      variants: experiment.variants,
      startedAt: experiment.startedAt ?? null,
      // The legacy read honours a window only when both ends are given.
      ...(input.since && input.until
        ? { since: input.since, until: input.until }
        : {}),
    });
    return deco
      ? {
          available: true,
          reason: null,
          analyticsSite: slug,
          source: "deco-analytics" as const,
          results: deco,
        }
      : unavailable;
  },
});
