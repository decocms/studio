import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { githubGraphql } from "./graphql";

/**
 * One read for everything the PR panel shows: the branch's pull request, its
 * check runs, its review state and its comments, at ONE instant — four separate
 * polls could render a PR's checks beside a different poll's mergeability.
 *
 * `reviewDecision` and `reviewThreads.isResolved` are the point. REST exposes
 * neither, so the panel used to infer "blocked on a human" from
 * `mergeable_state` and count unresolved conversations as every review comment
 * ever left.
 *
 * Matched by `headRefName`, not by walking `repository.ref(...)`: a ref deleted
 * after its merge makes the ref walk answer null, losing a merged PR the panel
 * still shows. This matches the head ref the PR RECORDS, as REST's `head:` did.
 */
const PR_STATE_QUERY = `
query PrState($owner: String!, $repo: String!, $branch: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(
      headRefName: $branch
      first: 1
      orderBy: { field: UPDATED_AT, direction: DESC }
    ) {
      nodes {
        number
        title
        body
        state
        merged
        mergedAt
        isDraft
        mergeable
        reviewDecision
        changedFiles
        url
        baseRefName
        headRefName
        headRefOid
        headRepository { nameWithOwner }
        author { login }
        reviewThreads(first: 100) { nodes { isResolved } }
        comments(last: 50) {
          nodes { databaseId author { login } body createdAt url }
        }
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first: 100) {
                  nodes {
                    __typename
                    ... on CheckRun {
                      databaseId
                      name
                      status
                      conclusion
                      detailsUrl
                      startedAt
                      completedAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const checkRunSchema = z.object({
  /** REST check-run id — what GET_CHECK_RUN takes to load the run's output. */
  id: z.string(),
  name: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
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
  htmlUrl: z.string(),
  durationMs: z.number().nullable(),
});

const commentSchema = z.object({
  id: z.number(),
  author: z.string(),
  body: z.string(),
  createdAt: z.string(),
  htmlUrl: z.string(),
});

const pullRequestSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string(),
  state: z.enum(["open", "closed"]),
  merged: z.boolean(),
  mergedAt: z.string().nullable(),
  base: z.string(),
  head: z.string(),
  headSha: z.string(),
  /** `owner/name` of the head repo; null when a fork was deleted. */
  headRepoFullName: z.string().nullable(),
  htmlUrl: z.string(),
  author: z.string(),
  draft: z.boolean(),
  /** Kept in the app's REST vocabulary so the panel state machine is unchanged. */
  mergeableState: z.enum(["clean", "dirty", "blocked", "unknown"]),
  /** Review threads GitHub reports as unresolved — a count, not a guess. */
  unresolvedConversations: z.number(),
  missingRequiredApprovals: z.boolean(),
  /** Files the PR touches — the Changes tab's badge, without reading bodies. */
  changedFiles: z.number(),
  checks: z.array(checkRunSchema),
  comments: z.array(commentSchema),
});

const prStateOutput = z.object({
  /** null when the branch has no pull request at all. */
  pullRequest: pullRequestSchema.nullable(),
});

export type PrStateResult = z.infer<typeof prStateOutput>;
type PullRequestState = z.infer<typeof pullRequestSchema>;
type CheckRunState = z.infer<typeof checkRunSchema>;

interface RawCheckRun {
  __typename?: string | null;
  databaseId?: number | null;
  name?: string | null;
  status?: string | null;
  conclusion?: string | null;
  detailsUrl?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

interface RawPullRequest {
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  merged?: boolean | null;
  mergedAt?: string | null;
  isDraft?: boolean | null;
  mergeable?: string | null;
  reviewDecision?: string | null;
  changedFiles?: number | null;
  url?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
  headRefOid?: string | null;
  headRepository?: { nameWithOwner?: string | null } | null;
  author?: { login?: string | null } | null;
  reviewThreads?: {
    nodes?: Array<{ isResolved?: boolean | null } | null> | null;
  } | null;
  comments?: {
    nodes?: Array<{
      databaseId?: number | null;
      author?: { login?: string | null } | null;
      body?: string | null;
      createdAt?: string | null;
      url?: string | null;
    } | null> | null;
  } | null;
  commits?: {
    nodes?: Array<{
      commit?: {
        statusCheckRollup?: {
          contexts?: { nodes?: Array<RawCheckRun | null> | null } | null;
        } | null;
      } | null;
    } | null> | null;
  } | null;
}

export interface PrStateResponse {
  repository?: {
    pullRequests?: { nodes?: Array<RawPullRequest | null> | null } | null;
  } | null;
}

/** GraphQL's status enum is wider than the three states the panel draws. */
function mapCheckStatus(
  raw: string | null | undefined,
): CheckRunState["status"] {
  if (raw === "IN_PROGRESS") return "in_progress";
  if (raw === "COMPLETED") return "completed";
  return "queued";
}

/**
 * GraphQL carries two conclusions REST's vocabulary has no word for.
 * `STARTUP_FAILURE` is a failure by any reading; `STALE` is a run superseded
 * before it concluded, which is informational — neither may leak through as an
 * unhandled string.
 */
function mapCheckConclusion(
  raw: string | null | undefined,
): CheckRunState["conclusion"] {
  switch (raw) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "STARTUP_FAILURE":
      return "failure";
    case "NEUTRAL":
    case "STALE":
      return "neutral";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    case "TIMED_OUT":
      return "timed_out";
    case "ACTION_REQUIRED":
      return "action_required";
    default:
      return null;
  }
}

/** The rollup also carries legacy StatusContexts; the panel draws check runs. */
function mapChecks(pr: RawPullRequest): CheckRunState[] {
  const contexts =
    pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const runs: CheckRunState[] = [];
  for (const node of contexts) {
    if (!node || node.__typename !== "CheckRun") continue;
    const startedAt = node.startedAt;
    const completedAt = node.completedAt;
    runs.push({
      id: node.databaseId == null ? "" : String(node.databaseId),
      name: node.name ?? "",
      status: mapCheckStatus(node.status),
      conclusion: mapCheckConclusion(node.conclusion),
      htmlUrl: node.detailsUrl ?? "",
      durationMs:
        startedAt && completedAt
          ? new Date(completedAt).getTime() - new Date(startedAt).getTime()
          : null,
    });
  }
  return runs;
}

/**
 * Fold the GraphQL payload into the panel's shape. `mergeableState` keeps REST's
 * vocabulary (the panel state machine is written against it) but is derived, not
 * reported: "blocked" means blocked on a PERSON. Required status checks belong
 * to `checks`, which the panel draws precisely rather than as a generic block.
 */
export function parsePrState(payload: PrStateResponse): PrStateResult {
  const repository = payload.repository;
  if (!repository) {
    throw new Error(
      "Repository not found or not accessible by this connection",
    );
  }
  const pr = repository.pullRequests?.nodes?.[0];
  if (!pr) return { pullRequest: null };

  const unresolvedConversations = (pr.reviewThreads?.nodes ?? []).filter(
    (thread) => thread?.isResolved === false,
  ).length;
  const decision = pr.reviewDecision;
  const missingRequiredApprovals =
    decision === "REVIEW_REQUIRED" || decision === "CHANGES_REQUESTED";

  const mergeableState: PullRequestState["mergeableState"] =
    pr.mergeable === "CONFLICTING"
      ? "dirty"
      : pr.mergeable !== "MERGEABLE"
        ? "unknown"
        : missingRequiredApprovals || unresolvedConversations > 0
          ? "blocked"
          : "clean";

  return {
    pullRequest: {
      number: pr.number ?? 0,
      title: pr.title ?? "",
      body: pr.body ?? "",
      // GraphQL splits merged out of closed; the panel's vocabulary does not.
      state: pr.state === "OPEN" ? "open" : "closed",
      merged: pr.merged === true,
      mergedAt: pr.mergedAt ?? null,
      base: pr.baseRefName ?? "main",
      head: pr.headRefName ?? "",
      headSha: pr.headRefOid ?? "",
      headRepoFullName: pr.headRepository?.nameWithOwner ?? null,
      htmlUrl: pr.url ?? "",
      author: pr.author?.login ?? "",
      draft: pr.isDraft === true,
      mergeableState,
      unresolvedConversations,
      missingRequiredApprovals,
      changedFiles: pr.changedFiles ?? 0,
      checks: mapChecks(pr),
      comments: (pr.comments?.nodes ?? []).flatMap((comment) =>
        comment
          ? [
              {
                id: comment.databaseId ?? 0,
                author: comment.author?.login ?? "",
                body: comment.body ?? "",
                createdAt: comment.createdAt ?? "",
                htmlUrl: comment.url ?? "",
              },
            ]
          : [],
      ),
    },
  };
}

export const GITHUB_PR_STATE = defineTool({
  name: "GITHUB_PR_STATE",
  description:
    "Read a branch's pull request with its check runs, review state and comments in a single GitHub GraphQL query.",
  annotations: {
    title: "Read GitHub Pull Request State",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    connectionId: z.string().describe("ID of the mcp-github connection to use"),
    owner: z.string().describe("Repository owner (user or org login)"),
    repo: z.string().describe("Repository name"),
    branch: z.string().describe("Head branch of the pull request to read"),
  }),
  outputSchema: prStateOutput,
  handler: async (input, ctx) => {
    await ctx.access.check();

    const data = await githubGraphql<PrStateResponse>(ctx, {
      connectionId: input.connectionId,
      query: PR_STATE_QUERY,
      variables: {
        owner: input.owner,
        repo: input.repo,
        branch: input.branch,
      },
      label: `pull request state for ${input.owner}/${input.repo}@${input.branch}`,
      operation: "pr_state",
    });

    return parsePrState(data);
  },
});
