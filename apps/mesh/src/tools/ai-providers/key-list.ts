import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { PROVIDER_IDS } from "../../ai-providers/provider-ids";
import {
  checkKeyPermission,
  fetchModelPermissions,
} from "@/api/routes/decopilot/model-permissions";

export const AI_PROVIDER_KEY_LIST = defineTool({
  name: "AI_PROVIDER_KEY_LIST",
  description:
    "List stored AI provider API keys. Returns metadata only — secrets are never exposed.",
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
  },
  inputSchema: z.object({
    providerId: z.enum(PROVIDER_IDS).optional(),
  }),
  outputSchema: z.object({
    keys: z.array(
      z.object({
        id: z.string(),
        providerId: z.string(),
        label: z.string(),
        presetId: z.string().nullable(),
        createdBy: z.string(),
        createdAt: z.string(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const [keys, allowedModels] = await Promise.all([
      ctx.storage.aiProviderKeys.list({
        organizationId: org.id,
        providerId: input.providerId,
      }),
      fetchModelPermissions(ctx.db, org.id, ctx.auth.user?.role),
    ]);

    const filtered = keys.filter((k) =>
      checkKeyPermission(allowedModels, k.id),
    );

    // Remove organizationId since it's implicit in the user's context
    const result = filtered.map(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ({ organizationId, ...key }) => key,
    );

    return { keys: result };
  },
});
