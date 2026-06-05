/**
 * OBSERVATION_SWEEP_RUN Tool
 *
 * Manually runs the observational-agent sweep for the caller's organization,
 * instead of waiting for the 15-minute cron. Fires the observer on every thread
 * currently idle past the configured threshold (respecting the skip-list and
 * loop-prevention rules). Useful for testing and on-demand catch-up.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { runObservationSweepForOrg } from "../../observation";

export const OBSERVATION_SWEEP_RUN = defineTool({
  name: "OBSERVATION_SWEEP_RUN",
  description:
    "Run the observational-agent sweep for this organization now. Fires the configured observer on every thread currently idle past the configured threshold. No-op if no observational agent is configured.",
  annotations: {
    title: "Run Observational Sweep",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    observed: z
      .number()
      .describe("Number of threads an observer run was fired for"),
    skipped: z
      .number()
      .describe("Number of candidate threads skipped this run"),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();
    return await runObservationSweepForOrg(org.id);
  },
});
