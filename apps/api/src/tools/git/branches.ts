/**
 * Branch search, server-side and provider-neutral.
 *
 * Replaces `GITHUB_SEARCH_BRANCHES`, which was GitHub by construction: it
 * posted GitHub's own GraphQL query. The filtering still happens at the
 * provider — a repository with hundreds of branches makes a client-side grep
 * over a paged listing useless — but which provider is now the repository's
 * answer, not the tool's.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { contentClientForTarget } from "@/git-providers/content";
import { repoTargetInput, repoTargetOf } from "./repo-target";

export const REPOSITORY_SEARCH_BRANCHES = defineTool({
  name: "REPOSITORY_SEARCH_BRANCHES",
  description:
    "Search a repository's branches by a case-insensitive substring of the branch name, filtered server-side by the provider.",
  annotations: {
    title: "Search Repository Branches",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    query: z
      .string()
      .describe(
        "Substring to match against branch names. Empty returns the first branches alphabetically.",
      ),
    limit: z.number().int().min(1).max(100).default(30),
    cursor: z
      .string()
      .nullish()
      .describe(
        "Opaque cursor from a previous call's `nextCursor`, to read the next window",
      ),
  }),
  outputSchema: z.object({
    branches: z.array(
      z.object({
        name: z.string(),
        /** Null when the provider cannot attribute the head commit. */
        author: z.string().nullable(),
      }),
    ),
    /** Total branches matching `query`, which may exceed `branches.length`. */
    totalCount: z.number(),
    /** Pass back verbatim for the next window; null when exhausted. */
    nextCursor: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) throw new Error("Organization context required");
    const client = await contentClientForTarget(
      ctx,
      organizationId,
      repoTargetOf(input),
    );
    return client.searchBranches({
      query: input.query,
      limit: input.limit,
      cursor: input.cursor,
    });
  },
});
