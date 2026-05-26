import z from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/mesh-context";
import { getDecobotConfig } from "@/git-providers/adapters/github";

export const GIT_PROVIDER_INSTALLATION_DELETE = defineTool({
  name: "GIT_PROVIDER_INSTALLATION_DELETE",
  description:
    "Remove a Decobot installation from this org's records. Does NOT revoke the App on GitHub — see `githubRevokeUrl` in the response for the GitHub-side link.",
  annotations: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: true,
  },
  inputSchema: z.object({
    id: z.string().describe("Studio installation id (gpi_...)"),
  }),
  outputSchema: z.object({
    deleted: z.boolean(),
    githubRevokeUrl: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const existing = await ctx.storage.gitProviderInstallations.findById(
      input.id,
      org.id,
    );
    await ctx.storage.gitProviderInstallations.delete(input.id, org.id);

    const cfg = getDecobotConfig();
    const revokeUrl =
      cfg && existing
        ? `https://github.com/${existing.accountType === "Organization" ? "organizations/" + existing.accountLogin + "/settings" : "settings"}/installations/${existing.installationId}`
        : undefined;

    return { deleted: true, githubRevokeUrl: revokeUrl };
  },
});
