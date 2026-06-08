import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { ObservationalConfigSchema } from "./schema";

export const OBSERVATION_CONFIG_GET = defineTool({
  name: "OBSERVATION_CONFIG_GET",
  description:
    "Get the organization's observational-agent configuration — the list of observers that run over idle threads.",
  annotations: {
    title: "Get Observation Config",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    observational_config: ObservationalConfigSchema.nullable(),
  }),

  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }

    const settings = await ctx.storage.organizationSettings.get(organizationId);
    return { observational_config: settings?.observational_config ?? null };
  },
});
