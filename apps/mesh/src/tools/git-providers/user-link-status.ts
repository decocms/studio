import { sql } from "kysely";
import z from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, requireAuth } from "../../core/mesh-context";
import { getGitProvider } from "@/git-providers/registry";

interface AccountRow {
  accountId: string | null;
  accessTokenExpiresAt: Date | string | null;
}

export const GIT_PROVIDER_USER_LINK_STATUS = defineTool({
  name: "GIT_PROVIDER_USER_LINK_STATUS",
  description:
    "Check whether the calling user has linked their personal GitHub identity to Studio. Returns the link URL if not linked.",
  annotations: { readOnlyHint: true, idempotentHint: true },
  inputSchema: z.object({
    providerId: z.literal("github").default("github"),
    /** Optional URL the user should be returned to after linking. */
    redirectTo: z.string().url().optional(),
  }),
  outputSchema: z.object({
    linked: z.boolean(),
    githubAccountId: z.string().optional(),
    linkUrl: z.string(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) throw new Error("Unable to determine user ID");

    const adapter = getGitProvider(input.providerId);
    const linkUrl = adapter.buildUserLinkUrl({
      baseUrl: ctx.baseUrl,
      redirectTo: input.redirectTo,
    });

    // Same raw-SQL lookup as the adapter — Better Auth's `account` table isn't
    // in our Kysely Database type (it manages its own schema).
    const row = await sql<AccountRow>`
      SELECT "accountId", "accessTokenExpiresAt"
      FROM "account"
      WHERE "userId" = ${userId} AND "providerId" = 'github'
      ORDER BY "accessTokenExpiresAt" DESC NULLS LAST
      LIMIT 1
    `
      .execute(ctx.db)
      .then((r) => r.rows[0]);

    if (!row?.accountId) {
      return { linked: false, linkUrl };
    }

    return {
      linked: true,
      githubAccountId: row.accountId,
      linkUrl,
    };
  },
});
