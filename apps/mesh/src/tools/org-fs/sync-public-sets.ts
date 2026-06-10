import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { getPublicUrl } from "../../core/server-constants";
import { syncAllPublicSets } from "../../file-storage/skill-set-sync";

/**
 * Manually re-sync the deployment's public skill sets from their GitHub
 * sources (the boot-time interval loop is the steady state; this is the
 * "I just pushed to the skills repo" button). Not in basic usage — admin
 * roles only via the default access check.
 */
export const ORG_FS_PUBLIC_SETS_SYNC = defineTool({
  name: "ORG_FS_PUBLIC_SETS_SYNC",
  description:
    "Re-sync the shared public skill-set volumes (org/public/*) from their configured GitHub repos. Returns per-set written/deleted/unchanged counts.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    results: z.array(
      z.union([
        z.object({
          set: z.string(),
          written: z.number(),
          deleted: z.number(),
          unchanged: z.number(),
        }),
        z.object({ set: z.string(), error: z.string() }),
      ]),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const results = await syncAllPublicSets(ctx.db, {
      baseUrl: getPublicUrl(),
    });
    return { results };
  },
});
