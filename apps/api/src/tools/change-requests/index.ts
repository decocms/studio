/**
 * App-only tools over a repository's change requests — what GitHub calls pull
 * requests and GitLab merge requests.
 *
 * They replace the browser's direct MCP traffic (`create_pull_request`,
 * `merge_pull_request`, `list_pull_requests`, `GET_CHECK_RUN`) and the
 * GitHub-named tools that preceded them (`GITHUB_PR_STATE`,
 * `GITHUB_LAST_PUBLISHED_PR`). Every one of those was GitHub by construction:
 * the browser held a GitHub MCP client and spoke GitHub's tool names, so a
 * GitLab project's panel had nothing to call.
 *
 * The repository is named by whatever the caller has — a repository id, a URL,
 * or a legacy connection — and the provider follows from the answer, never
 * from the caller.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import type { StudioContext } from "@/core/studio-context";
import {
  type ChangeRequestClient,
  changeRequestClientForTarget,
} from "@/git-providers";
import {
  NO_REPOSITORY_CREDENTIAL,
  repoTargetInput,
  type RepoTargetInput,
  repoTargetOf,
} from "@/tools/git/repo-target";

/** The client for a tool's target, or a throw naming what to do about it. */
async function clientFor(
  ctx: StudioContext,
  input: RepoTargetInput,
): Promise<ChangeRequestClient> {
  const organizationId = ctx.organization?.id;
  if (!organizationId) throw new Error("Organization context required");
  const client = await changeRequestClientForTarget(
    ctx,
    organizationId,
    repoTargetOf(input),
  );
  if (!client) throw new Error(NO_REPOSITORY_CREDENTIAL);
  return client;
}

const checkRunSchema = z.object({
  /** Null for a run with no addressable log (a GitHub commit status). */
  id: z.string().nullable(),
  name: z.string(),
  state: z.enum(["queued", "running", "completed"]),
  conclusion: z
    .enum([
      "success",
      "failure",
      "neutral",
      "cancelled",
      "skipped",
      "timed_out",
      "action_required",
    ])
    .nullable(),
  url: z.string().nullable(),
  durationMs: z.number().nullable(),
  summary: z.string().nullable(),
});

const commentSchema = z.object({
  id: z.string(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  url: z.string(),
});

const changeRequestSchema = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  /** `merged` is its own state — closed-unmerged means abandoned. */
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  mergedAt: z.string().nullable(),
  base: z.string(),
  head: z.string(),
  headSha: z.string(),
  headRepoPath: z.string().nullable(),
  author: z.string(),
  conflicting: z.boolean().nullable(),
  checks: z.enum(["pending", "passing", "failing"]).nullable(),
  changedFiles: z.number().nullable(),
});

const detailSchema = changeRequestSchema.extend({
  checkRuns: z.array(checkRunSchema),
  comments: z.array(commentSchema),
  unresolvedConversations: z.number(),
  reviewBlocked: z.boolean(),
});

export const CHANGE_REQUEST_STATE = defineTool({
  name: "CHANGE_REQUEST_STATE",
  description:
    "Read a branch's change request with its CI runs, review state and comments.",
  annotations: {
    title: "Read Change Request State",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    branch: z.string().describe("Head branch of the change request to read"),
  }),
  outputSchema: z.object({
    /** null when the branch has no change request at all. */
    changeRequest: detailSchema.nullable(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const client = await clientFor(ctx, input);
    return {
      changeRequest: await client.readDetailed({ branch: input.branch }),
    };
  },
});

export const CHANGE_REQUEST_LAST_MERGED = defineTool({
  name: "CHANGE_REQUEST_LAST_MERGED",
  description:
    "Read the most recently merged change request into a base branch — in Fast Preview, the last publish.",
  annotations: {
    title: "Read Last Merged Change Request",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    base: z.string().describe("Branch it was merged into"),
  }),
  outputSchema: z.object({
    /** null when nothing has ever been merged into this base. */
    changeRequest: changeRequestSchema.nullable(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const client = await clientFor(ctx, input);
    return { changeRequest: await client.lastMergedInto(input.base) };
  },
});

export const CHANGE_REQUEST_LIST_OPEN = defineTool({
  name: "CHANGE_REQUEST_LIST_OPEN",
  description:
    "List a repository's open change requests, most recently updated first.",
  annotations: {
    title: "List Open Change Requests",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    limit: z.number().int().min(1).max(100).default(50),
  }),
  outputSchema: z.object({ changeRequests: z.array(changeRequestSchema) }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const client = await clientFor(ctx, input);
    return { changeRequests: await client.listOpen(input.limit) };
  },
});

export const CHANGE_REQUEST_CHECK_LOG = defineTool({
  name: "CHANGE_REQUEST_CHECK_LOG",
  description:
    "Read one CI run's report — a GitHub check run's output markdown, or the tail of a GitLab job's trace.",
  annotations: {
    title: "Read CI Run Report",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    checkId: z.string().describe("Provider id of the run, from its listing"),
  }),
  outputSchema: z.object({ report: z.string().nullable() }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const client = await clientFor(ctx, input);
    return { report: await client.readCheckLog(input.checkId) };
  },
});

export const CHANGE_REQUEST_OPEN = defineTool({
  name: "CHANGE_REQUEST_OPEN",
  description:
    "Propose a branch onto another. Returns the branch's existing change request instead of failing when it already has one.",
  annotations: {
    title: "Open Change Request",
    readOnlyHint: false,
    destructiveHint: false,
    // Re-calling it yields the branch's one change request, never a second.
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    head: z.string().describe("Branch being proposed"),
    base: z.string().describe("Branch it should land on"),
    title: z.string(),
    body: z.string().optional(),
  }),
  outputSchema: z.object({
    changeRequest: changeRequestSchema,
    /** True when this call found an existing one rather than opening it. */
    existed: z.boolean(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const client = await clientFor(ctx, input);
    /**
     * Reuse before create, deliberately in that order: a branch has at most
     * one open change request, so the caller's intent ("this branch should be
     * proposed") is already satisfied by an existing one — and asking first is
     * one read, where creating and recovering from the duplicate refusal is a
     * write, a parse of the provider's prose, and then the read anyway.
     */
    const existing = await client.readForBranch(input.head);
    if (existing && existing.state === "open") {
      if (input.body && input.body !== existing.body) {
        await client.describe(existing.number, input.body);
      }
      return {
        changeRequest: input.body
          ? { ...existing, body: input.body }
          : existing,
        existed: true,
      };
    }
    const opened = await client.open({
      head: input.head,
      base: input.base,
      title: input.title,
      body: input.body,
    });
    return { changeRequest: opened, existed: false };
  },
});

export const CHANGE_REQUEST_MERGE = defineTool({
  name: "CHANGE_REQUEST_MERGE",
  description:
    "Land a change request. Reports why it could not merge rather than throwing.",
  annotations: {
    title: "Merge Change Request",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    ...repoTargetInput,
    number: z.number().int().positive(),
    strategy: z
      .enum(["any", "squash"])
      .default("any")
      .describe(
        "`squash` when the result must be one commit; `any` uses whatever the repository allows",
      ),
    commitTitle: z.string().optional(),
    commitMessage: z.string().optional(),
  }),
  outputSchema: z.object({
    merged: z.boolean(),
    /** Absent on success. Who has to act, not the provider's status code. */
    reason: z
      .enum(["conflict", "blocked", "rate_limited", "not_found", "error"])
      .optional(),
    detail: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();
    const client = await clientFor(ctx, input);
    const outcome = await client.merge(input.number, {
      strategy: input.strategy,
      commitTitle: input.commitTitle,
      commitMessage: input.commitMessage,
    });
    return outcome.merged
      ? { merged: true }
      : { merged: false, reason: outcome.reason, detail: outcome.detail };
  },
});
