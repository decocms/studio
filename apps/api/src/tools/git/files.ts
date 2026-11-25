/**
 * Read a file and write files to a branch, for an app that proposes a change
 * by pull request.
 *
 * Until now a member's writes reached a repository only through the site
 * editor's decofile path, so content that lives outside the CMS (a site's
 * `content/blog/` posts, read at build time) had no way in: CHANGE_REQUEST_OPEN
 * could open the pull request, but nothing could put the change on its branch.
 * These are that missing half. Writing never touches the default branch, and a
 * branch that already exists takes a commit only on top of the head the caller
 * saw. Read a file, then start the branch at the commit you read it from
 * (`baseSha`): a concurrent edit to the same lines then shows as a conflict on
 * the pull request instead of being silently overwritten.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  contentClientForTarget,
  RepoWriteConflict,
  requireBranchHead,
} from "@/git-providers";
import {
  MAX_COMMIT_FILES,
  branchNameIssue,
  filesIssues,
  isCommitSha,
  pathShapeIssue,
} from "./commit-rules";
import { repoTargetInput, repoTargetOf } from "./repo-target";

const FileInputSchema = z.union([
  z.object({
    path: z.string().describe("Path from the repository root"),
    content: z.string().describe("The file's full new text (UTF-8)"),
  }),
  z.object({
    path: z.string().describe("Path from the repository root"),
    deleted: z.literal(true).describe("Remove this file"),
  }),
]);

export const REPOSITORY_COMMIT_FILES = defineTool({
  name: "REPOSITORY_COMMIT_FILES",
  description:
    "Write files to a branch in one commit, to propose them with CHANGE_REQUEST_OPEN. A missing branch is created at `baseSha` when given (the commit REPOSITORY_READ_FILE returned), else at the head of `base` (default: the repository's default branch). An existing branch takes the commit only when `expectedHead` is its current head. Never writes the default branch, .git/ or .github/.",
  annotations: {
    title: "Commit files to a branch",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    branch: z
      .string()
      .describe("Branch to write; created from `base` when it does not exist"),
    base: z
      .string()
      .optional()
      .describe(
        "Where a new branch starts. Default: the repository's default branch",
      ),
    baseSha: z
      .string()
      .optional()
      .describe(
        "Where a new branch starts, as a commit id: the `sha` REPOSITORY_READ_FILE returned, so the change applies to what you read",
      ),
    expectedHead: z
      .string()
      .optional()
      .describe(
        "Required when `branch` exists: its head sha as you last saw it (the `sha` a previous call returned)",
      ),
    message: z.string().min(1).max(5000).describe("Commit message"),
    files: z.array(FileInputSchema).min(1).max(MAX_COMMIT_FILES),
  }),
  outputSchema: z.object({
    branch: z.string(),
    /** The branch a new branch started from (`base`, or the default branch). */
    base: z.string(),
    /** The new commit: the branch's head now. Pass it as the next call's `expectedHead`. */
    sha: z.string(),
    /** True when this call created the branch. */
    created: z.boolean(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) throw new Error("Organization context required");

    const branchIssue = branchNameIssue(input.branch);
    if (branchIssue) throw new Error(`branch ${branchIssue}`);
    if (input.baseSha !== undefined && !isCommitSha(input.baseSha))
      throw new Error("baseSha must be a full commit id (40 hex characters)");
    const issues = filesIssues(input.files);
    if (issues.length) throw new Error(`Cannot write: ${issues.join("; ")}`);

    const client = await contentClientForTarget(
      ctx,
      organizationId,
      repoTargetOf(input),
    );
    const defaultBranch = await client.getDefaultBranch();
    const base = input.base ?? defaultBranch;
    // What ships is the default branch, and it changes only by a merge.
    if (input.branch === defaultBranch || input.branch === base) {
      throw new Error(
        `Will not write ${input.branch} directly: write a new branch and open a change request onto it`,
      );
    }

    const head = await client.getBranch(input.branch);
    let parent: string;
    let created = false;
    if (head) {
      if (!input.expectedHead) {
        throw new Error(
          `Branch ${input.branch} already exists at ${head.sha}. Pass expectedHead: "${head.sha}" to add a commit on top of it`,
        );
      }
      if (input.expectedHead !== head.sha) {
        throw new RepoWriteConflict(
          `Branch ${input.branch} is at ${head.sha}, not at expectedHead ${input.expectedHead}`,
        );
      }
      parent = head.sha;
    } else {
      parent = input.baseSha ?? (await requireBranchHead(client, base));
      // If the commit below fails, the branch stays where `base` was: no
      // change to propose, and a retry names it with expectedHead.
      await client.createBranch(input.branch, parent);
      created = true;
    }

    const { sha } = await client.commitFiles({
      branch: input.branch,
      message: input.message,
      expectedHead: parent,
      changes: input.files,
      inlineContent: true,
    });
    return { branch: input.branch, base, sha, created };
  },
});

export const REPOSITORY_READ_FILE = defineTool({
  name: "REPOSITORY_READ_FILE",
  description:
    "Read one file's text at a branch or commit (default: the repository's default branch). Returns the commit id it read from; pass it as REPOSITORY_COMMIT_FILES's `baseSha` so a change applies to what you read.",
  annotations: {
    title: "Read a repository file",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    path: z.string().describe("Path from the repository root"),
    ref: z
      .string()
      .optional()
      .describe(
        "Branch name or full commit id. Default: the repository's default branch",
      ),
  }),
  outputSchema: z.object({
    path: z.string(),
    /** The commit the file was read at. */
    sha: z.string(),
    /** The file's text, or null when it does not exist at that commit. */
    content: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const organizationId = ctx.organization?.id;
    if (!organizationId) throw new Error("Organization context required");
    const pathIssue = pathShapeIssue(input.path);
    if (pathIssue) throw new Error(`path ${pathIssue}`);

    const client = await contentClientForTarget(
      ctx,
      organizationId,
      repoTargetOf(input),
    );
    const ref = input.ref ?? (await client.getDefaultBranch());
    // Pin the read to a commit, so the caller can start a branch exactly there.
    const sha = isCommitSha(ref) ? ref : await requireBranchHead(client, ref);
    const content = await client.readFileAtRef(sha, input.path);
    return { path: input.path, sha, content };
  },
});
