import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";

export const GIT_PROVIDER_INSTALLATION_LIST = defineTool({
  name: "GIT_PROVIDER_INSTALLATION_LIST",
  description:
    "List Decobot installations for the current organization (across providers).",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: z.object({
    providerId: z.literal("github").optional(),
  }),
  outputSchema: z.object({
    installations: z.array(
      z.object({
        id: z.string(),
        providerId: z.string(),
        installationId: z.string(),
        accountLogin: z.string(),
        accountId: z.string(),
        accountType: z.enum(["Organization", "User"]),
        repositorySelection: z.enum(["all", "selected"]),
        createdBy: z.string(),
        createdAt: z.string(),
        updatedAt: z.string(),
      }),
    ),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const installations = await ctx.storage.gitProviderInstallations.list({
      organizationId: org.id,
      providerId: input.providerId,
    });

    // Strip organizationId from public payload (it's implicit).
    const stripped = installations.map(
      ({ organizationId: _o, ...rest }) => rest,
    );
    return { installations: stripped };
  },
});
