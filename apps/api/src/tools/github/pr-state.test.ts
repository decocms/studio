import { describe, expect, it } from "bun:test";
import { parsePrState, type PrStateResponse } from "./pr-state";

function payload(over: Record<string, unknown> = {}): PrStateResponse {
  return {
    repository: {
      pullRequests: {
        nodes: [
          {
            number: 42,
            title: "Add hero section",
            body: "",
            state: "OPEN",
            merged: false,
            mergedAt: null,
            isDraft: false,
            mergeable: "MERGEABLE",
            reviewDecision: null,
            changedFiles: 3,
            url: "https://github.com/acme/site/pull/42",
            baseRefName: "main",
            headRefName: "claude/hero",
            headRefOid: "abc123",
            headRepository: { nameWithOwner: "acme/site" },
            author: { login: "gimenes" },
            reviewThreads: { nodes: [] },
            comments: { nodes: [] },
            commits: { nodes: [] },
            ...over,
          },
        ],
      },
    },
  };
}

describe("parsePrState", () => {
  it("maps a clean open pull request", () => {
    const { pullRequest } = parsePrState(payload());

    expect(pullRequest).toMatchObject({
      number: 42,
      state: "open",
      merged: false,
      base: "main",
      head: "claude/hero",
      headSha: "abc123",
      headRepoFullName: "acme/site",
      author: "gimenes",
      draft: false,
      mergeableState: "clean",
      unresolvedConversations: 0,
      missingRequiredApprovals: false,
      changedFiles: 3,
    });
  });

  it("returns null when the branch has no pull request", () => {
    expect(
      parsePrState({ repository: { pullRequests: { nodes: [] } } }),
    ).toEqual({ pullRequest: null });
  });

  it("throws when the repository is hidden rather than reporting no PR", () => {
    expect(() => parsePrState({ repository: null })).toThrow(
      /not found or not accessible/,
    );
  });

  /** GraphQL splits MERGED out of CLOSED; the panel's vocabulary does not. */
  it("reports a merged pull request as closed and merged", () => {
    const { pullRequest } = parsePrState(
      payload({
        state: "MERGED",
        merged: true,
        mergedAt: "2026-08-19T10:00:00Z",
      }),
    );

    expect(pullRequest).toMatchObject({
      state: "closed",
      merged: true,
      mergedAt: "2026-08-19T10:00:00Z",
    });
  });

  it("reads conflicts off `mergeable`", () => {
    expect(
      parsePrState(payload({ mergeable: "CONFLICTING" })).pullRequest,
    ).toMatchObject({ mergeableState: "dirty" });
  });

  it("reports UNKNOWN mergeability rather than guessing clean", () => {
    expect(
      parsePrState(payload({ mergeable: "UNKNOWN" })).pullRequest,
    ).toMatchObject({ mergeableState: "unknown" });
  });

  /**
   * The REST path inferred this from `mergeable_state === "blocked"` with no
   * unresolved conversations — a guess that was wrong whenever branch
   * protection blocked for any other reason. `reviewDecision` states it.
   */
  it("reads missing approvals off reviewDecision, not a mergeable_state guess", () => {
    expect(
      parsePrState(payload({ reviewDecision: "REVIEW_REQUIRED" })).pullRequest,
    ).toMatchObject({
      missingRequiredApprovals: true,
      mergeableState: "blocked",
    });

    expect(
      parsePrState(payload({ reviewDecision: "CHANGES_REQUESTED" }))
        .pullRequest,
    ).toMatchObject({
      missingRequiredApprovals: true,
      mergeableState: "blocked",
    });

    expect(
      parsePrState(payload({ reviewDecision: "APPROVED" })).pullRequest,
    ).toMatchObject({
      missingRequiredApprovals: false,
      mergeableState: "clean",
    });
  });

  /**
   * The REST path used the raw `review_comments` COUNT, which counts every
   * review comment ever left — resolved ones included. Only unresolved threads
   * are something a person still has to act on.
   */
  it("counts unresolved review threads, not every review comment", () => {
    const { pullRequest } = parsePrState(
      payload({
        reviewThreads: {
          nodes: [
            { isResolved: true },
            { isResolved: false },
            { isResolved: true },
            { isResolved: false },
          ],
        },
      }),
    );

    expect(pullRequest).toMatchObject({
      unresolvedConversations: 2,
      mergeableState: "blocked",
    });
  });

  it("maps check runs, keeping the REST id GET_CHECK_RUN needs", () => {
    const { pullRequest } = parsePrState(
      payload({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        databaseId: 987,
                        name: "build",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        detailsUrl: "https://github.com/acme/site/runs/987",
                        startedAt: "2026-08-19T10:00:00Z",
                        completedAt: "2026-08-19T10:01:30Z",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
    );

    expect(pullRequest?.checks).toEqual([
      {
        id: "987",
        name: "build",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/acme/site/runs/987",
        durationMs: 90_000,
      },
    ]);
  });

  it("drops legacy status contexts, which the panel does not draw", () => {
    const { pullRequest } = parsePrState(
      payload({
        commits: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      { __typename: "StatusContext", context: "ci/legacy" },
                      {
                        __typename: "CheckRun",
                        databaseId: 1,
                        name: "test",
                        status: "IN_PROGRESS",
                        conclusion: null,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      }),
    );

    expect(pullRequest?.checks).toHaveLength(1);
    expect(pullRequest?.checks[0]).toMatchObject({
      name: "test",
      status: "in_progress",
      conclusion: null,
      durationMs: null,
    });
  });

  it("folds the conclusions REST has no word for onto ones the panel draws", () => {
    const rollup = (conclusion: string) => ({
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      databaseId: 1,
                      name: "n",
                      status: "COMPLETED",
                      conclusion,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
    });

    expect(
      parsePrState(payload(rollup("STARTUP_FAILURE"))).pullRequest?.checks[0]
        ?.conclusion,
    ).toBe("failure");
    expect(
      parsePrState(payload(rollup("STALE"))).pullRequest?.checks[0]?.conclusion,
    ).toBe("neutral");
  });

  it("survives a deleted fork and a commit with no GitHub account", () => {
    const { pullRequest } = parsePrState(
      payload({ headRepository: null, author: null }),
    );

    expect(pullRequest).toMatchObject({
      headRepoFullName: null,
      author: "",
    });
  });

  it("maps issue comments", () => {
    const { pullRequest } = parsePrState(
      payload({
        comments: {
          nodes: [
            {
              databaseId: 7,
              author: { login: "octocat" },
              body: "ship it",
              createdAt: "2026-08-19T09:00:00Z",
              url: "https://github.com/acme/site/pull/42#issuecomment-7",
            },
            null,
          ],
        },
      }),
    );

    expect(pullRequest?.comments).toEqual([
      {
        id: 7,
        author: "octocat",
        body: "ship it",
        createdAt: "2026-08-19T09:00:00Z",
        htmlUrl: "https://github.com/acme/site/pull/42#issuecomment-7",
      },
    ]);
  });
});
