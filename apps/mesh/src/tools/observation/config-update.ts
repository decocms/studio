import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth } from "../../core/studio-context";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import { ObservationalConfigSchema } from "./schema";

export const OBSERVATION_CONFIG_UPDATE = defineTool({
  name: "OBSERVATION_CONFIG_UPDATE",
  description:
    "Replace the organization's observational-agent configuration (the list of observers). Each observer is assigned a stable id and a forward-only configuredAt timestamp server-side.",
  annotations: {
    title: "Update Observation Config",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    organizationId: z.string(),
    observational_config: ObservationalConfigSchema,
  }),
  outputSchema: z.object({
    observational_config: ObservationalConfigSchema.nullable(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    if (ctx.organization && ctx.organization.id !== input.organizationId) {
      throw new Error("Cannot update config for a different organization");
    }

    // For each observer: mint a stable id if missing, and stamp `configuredAt`
    // server-side so observation is forward-only — the sweep only considers
    // threads active at/after it, never the org's pre-existing history. An
    // existing observer (matched by id) keeps its original configuredAt across
    // edits; a newly-added one is stamped now. id and configuredAt are
    // server-authoritative (client values ignored).
    const prev = await ctx.storage.organizationSettings.get(
      input.organizationId,
    );
    const prevById = new Map(
      (prev?.observational_config?.observers ?? []).map((o) => [o.id, o]),
    );
    const now = new Date().toISOString();
    const seen = new Set<string>();
    const observers = input.observational_config.observers.map((o) => {
      const prevObs = o.id ? prevById.get(o.id) : undefined;
      // Keep a valid existing id; mint a new one if empty or colliding.
      let id = o.id;
      if (!id || seen.has(id)) id = generatePrefixedId("obs");
      seen.add(id);
      return { ...o, id, configuredAt: prevObs?.configuredAt ?? now };
    });

    const settings = await ctx.storage.organizationSettings.upsert(
      input.organizationId,
      { observational_config: { observers } },
    );
    return { observational_config: settings.observational_config ?? null };
  },
});
