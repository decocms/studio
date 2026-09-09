/**
 * How an app-only tool names the repository it acts on.
 *
 * All three fields are optional because the three eras of records carry
 * different ones — a repository id is what everything writes now, an identity
 * is what older rows have, and a connection is the pre-repository world. At
 * least one that RESOLVES is required, which the resolver enforces rather than
 * the schema: which of them is present is not the caller's fault to explain.
 */

import { z } from "zod";
import { parseRepoUrl } from "@decocms/shared/git-providers";
import type { RepoTarget } from "@/git-providers";

export const repoTargetInput = {
  repositoryId: z
    .string()
    .optional()
    .describe("Connected repository (REPOSITORY_LINK) to act on"),
  repoUrl: z
    .string()
    .optional()
    .describe(
      "Any URL of the repository — its provider and host are read from it",
    ),
  connectionId: z
    .string()
    .optional()
    .describe("Legacy: a repo-scoped mcp-github connection in this org"),
};

export interface RepoTargetInput {
  repositoryId?: string;
  repoUrl?: string;
  connectionId?: string;
}

export function repoTargetOf(input: RepoTargetInput): RepoTarget {
  return {
    repositoryId: input.repositoryId,
    ref: input.repoUrl ? parseRepoUrl(input.repoUrl) : null,
    connectionId: input.connectionId,
  };
}

/**
 * What a tool says when no credential path resolves. A tool throws where the
 * task board returns null: a panel that silently renders empty is
 * indistinguishable from a repository with no change requests, and the
 * difference is exactly what a reader needs to know.
 */
export const NO_REPOSITORY_CREDENTIAL =
  "No credential for this repository — link it in Settings → Repositories";
