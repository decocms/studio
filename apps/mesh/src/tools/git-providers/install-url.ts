import z from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { getGitProvider } from "@/git-providers/registry";

export const GIT_PROVIDER_INSTALL_URL = defineTool({
  name: "GIT_PROVIDER_INSTALL_URL",
  description:
    "Generate the GitHub App install URL for Decobot. Returns URL and an opaque state token to pass to GIT_PROVIDER_INSTALL_COMPLETE.",
  annotations: { readOnlyHint: false, idempotentHint: false },
  inputSchema: z.object({
    providerId: z.literal("github").default("github"),
  }),
  outputSchema: z.object({
    url: z.string(),
    stateToken: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const adapter = getGitProvider(input.providerId);
    if (!adapter.info.available) {
      throw new Error(
        `${input.providerId} provider is not configured on this Studio instance.`,
      );
    }

    // Reuse the OAuth PKCE state storage just for the opaque single-use state
    // token — there's no PKCE verifier for the GitHub App install flow, but
    // the storage's (org, user, single-use, TTL) semantics are what we want.
    const stateToken = await ctx.storage.oauthPkceStates.create(
      `git-install:${input.providerId}`,
      org.id,
      userId,
    );

    const url = adapter.buildInstallUrl({
      state: stateToken,
      baseUrl: ctx.baseUrl,
    });

    return { url, stateToken };
  },
});
