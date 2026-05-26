import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { getGitProvider } from "@/git-providers/registry";

const installationInfoSchema = z.object({
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
});

export const GIT_PROVIDER_INSTALL_COMPLETE = defineTool({
  name: "GIT_PROVIDER_INSTALL_COMPLETE",
  description:
    "Finalize a Decobot install. Call this after the GitHub install callback fires, with installationId and stateToken.",
  annotations: { readOnlyHint: false, idempotentHint: true },
  inputSchema: z.object({
    providerId: z.literal("github").default("github"),
    installationId: z.string(),
    stateToken: z.string(),
  }),
  outputSchema: installationInfoSchema,
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    // Validate single-use state — same storage backing the AI provider OAuth.
    await ctx.storage.oauthPkceStates.consume(input.stateToken, org.id, userId);

    const adapter = getGitProvider(input.providerId);
    const meta = await adapter.fetchInstallation(input.installationId);

    const info = await ctx.storage.gitProviderInstallations.upsert({
      providerId: input.providerId,
      installationId: meta.installationId,
      accountLogin: meta.accountLogin,
      accountId: meta.accountId,
      accountType: meta.accountType,
      repositorySelection: meta.repositorySelection,
      organizationId: org.id,
      createdBy: userId,
    });

    return info;
  },
});
