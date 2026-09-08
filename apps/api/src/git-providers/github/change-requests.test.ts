/**
 * GitHub's vocabulary, mapped into the neutral one. Pure — the round-trips
 * themselves are e2e.
 *
 * Ported from the task board's `checks-status.test.ts`, which is where these
 * rules were earned while GitHub was reached through MCP. They are unchanged;
 * only their home moved, next to the implementation that owns the vocabulary.
 */
import { describe, expect, it } from "bun:test";
import type { RepoRef } from "@decocms/shared/git-providers";
import {
  checksFromMergeableState,
  conflictFromPullRequest,
  isMergeMethodNotAllowed,
  mapChecks,
  mapDetail,
  mapPullRequest,
  pickMostRecentlyMerged,
  type RawGraphqlChangeRequest,
} from "./change-requests";

const REPO: RepoRef = {
  provider: "github",
  host: "github.com",
  path: "acme/site",
};

describe("conflictFromPullRequest", () => {
  it("maps an open pull request with mergeable === false to a conflict", () => {
    expect(conflictFromPullRequest({ state: "open", mergeable: false })).toBe(
      true,
    );
  });

  it("maps an open, mergeable one to false", () => {
    expect(conflictFromPullRequest({ state: "open", mergeable: true })).toBe(
      false,
    );
  });

  it("is null while GitHub has not computed mergeability", () => {
    expect(
      conflictFromPullRequest({ state: "open", mergeable: null }),
    ).toBeNull();
    expect(conflictFromPullRequest({ state: "open" })).toBeNull();
  });

  /** A merged or closed one reports no mergeability, but is never conflicting. */
  it("treats a non-open pull request as not conflicting", () => {
    expect(conflictFromPullRequest({ state: "closed" })).toBe(false);
    expect(
      conflictFromPullRequest({ state: "closed", mergeable_state: "dirty" }),
    ).toBe(false);
  });

  it("is null for nothing at all", () => {
    expect(conflictFromPullRequest(null)).toBeNull();
  });

  /**
   * The reason this reads `mergeable_state` at all: github-mcp's
   * `MinimalPullRequest` has no `mergeable`, so reading only the boolean
   * yielded null for every pull request ever and the conflict auto-resolution
   * it gates never fired once in production.
   */
  it("falls back to mergeable_state when the boolean is absent", () => {
    expect(
      conflictFromPullRequest({ state: "open", mergeable_state: "dirty" }),
    ).toBe(true);
    expect(
      conflictFromPullRequest({ state: "open", mergeable_state: "clean" }),
    ).toBe(false);
    expect(
      conflictFromPullRequest({ state: "open", mergeable_state: "blocked" }),
    ).toBe(false);
  });

  it("is null when mergeable_state is still being computed", () => {
    for (const mergeable_state of ["unknown", ""]) {
      expect(
        conflictFromPullRequest({ state: "open", mergeable_state }),
      ).toBeNull();
    }
  });

  it("prefers the boolean when a full payload carries both", () => {
    expect(
      conflictFromPullRequest({
        state: "open",
        mergeable: true,
        mergeable_state: "dirty",
      }),
    ).toBe(false);
  });
});

describe("checksFromMergeableState", () => {
  it("maps the two unambiguous values", () => {
    expect(checksFromMergeableState("clean")).toBe("passing");
    expect(checksFromMergeableState("unstable")).toBe("failing");
  });

  it("is null for everything that says nothing about checks", () => {
    /**
     * `blocked` is the load-bearing one: it also covers a missing required
     * review, so reading it as red would hold QA on a healthy deploy.
     */
    for (const state of ["blocked", "dirty", "behind", "unknown"]) {
      expect(checksFromMergeableState(state)).toBeNull();
    }
    expect(checksFromMergeableState(undefined)).toBeNull();
    expect(checksFromMergeableState(null)).toBeNull();
  });
});

describe("mapPullRequest", () => {
  it("reads a REST payload into the neutral shape", () => {
    expect(
      mapPullRequest({
        number: 7,
        html_url: "https://github.com/acme/site/pull/7",
        title: "feat: x",
        body: "why",
        state: "open",
        draft: false,
        mergeable: true,
        mergeable_state: "clean",
        changed_files: 3,
        base: { ref: "main" },
        head: {
          ref: "feat/x",
          sha: "abc1234",
          repo: { full_name: "acme/site" },
        },
        user: { login: "someone" },
      }),
    ).toEqual({
      number: 7,
      url: "https://github.com/acme/site/pull/7",
      title: "feat: x",
      body: "why",
      state: "open",
      draft: false,
      mergedAt: null,
      base: "main",
      head: "feat/x",
      headSha: "abc1234",
      headRepoPath: "acme/site",
      author: "someone",
      conflicting: false,
      checks: "passing",
      changedFiles: 3,
    });
  });

  /** `merged` is its own state, not a flavour of closed. */
  it("reads a merged pull request as merged, not closed", () => {
    const cr = mapPullRequest({
      number: 1,
      state: "closed",
      merged: true,
      merged_at: "2026-09-01T00:00:00Z",
    });
    expect(cr.state).toBe("merged");
    expect(cr.mergedAt).toBe("2026-09-01T00:00:00Z");
  });

  /** A payload with only `merged_at` (no boolean) still landed. */
  it("infers a merge from merged_at alone", () => {
    expect(
      mapPullRequest({
        state: "closed",
        merged_at: "2026-09-01T00:00:00Z",
      }).state,
    ).toBe("merged");
  });

  it("reads a closed-unmerged pull request as closed", () => {
    expect(mapPullRequest({ state: "closed" }).state).toBe("closed");
  });

  /** A fork's head repo differs; null once the fork is gone. */
  it("keeps the head repository path, or null when absent", () => {
    expect(
      mapPullRequest({ head: { repo: { full_name: "fork/site" } } })
        .headRepoPath,
    ).toBe("fork/site");
    expect(mapPullRequest({ head: { ref: "x" } }).headRepoPath).toBeNull();
  });
});

describe("mapChecks", () => {
  const rollup = (nodes: unknown[]): RawGraphqlChangeRequest => ({
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: { nodes: nodes as never },
            },
          },
        },
      ],
    },
  });

  /**
   * The rollup carries BOTH check runs and legacy commit statuses, and a
   * repository can post to either — a deco site whose combined status is empty
   * but whose "Deco / QA" check run failed, and a Cloudflare deploy that is
   * only ever a status. Reading both here is what collapsed the two separate
   * reads the MCP path made into one.
   */
  it("reads check runs and legacy commit statuses as the same thing", () => {
    const runs = mapChecks(
      rollup([
        {
          __typename: "CheckRun",
          databaseId: 42,
          name: "Deco / QA",
          status: "COMPLETED",
          conclusion: "FAILURE",
          detailsUrl: "https://github.com/acme/site/runs/42",
          startedAt: "2026-09-01T00:00:00Z",
          completedAt: "2026-09-01T00:00:30Z",
          summary: "it broke",
        },
        {
          __typename: "StatusContext",
          context: "deco/deploy",
          state: "SUCCESS",
          targetUrl: "https://envs-x--a1b2.decocdn.com",
          description: "deployed",
        },
      ]),
    );
    expect(runs).toEqual([
      {
        id: "42",
        name: "Deco / QA",
        state: "completed",
        conclusion: "failure",
        url: "https://github.com/acme/site/runs/42",
        durationMs: 30_000,
        summary: "it broke",
      },
      {
        id: null,
        name: "deco/deploy",
        state: "completed",
        conclusion: "success",
        url: "https://envs-x--a1b2.decocdn.com",
        durationMs: null,
        summary: "deployed",
      },
    ]);
  });

  /**
   * GraphQL carries two conclusions REST has no word for. `STARTUP_FAILURE`
   * is a failure by any reading; `STALE` is a run superseded before it
   * concluded, which is informational — neither may leak through unhandled.
   */
  it("maps the conclusions REST's vocabulary lacks", () => {
    const runs = mapChecks(
      rollup([
        {
          __typename: "CheckRun",
          status: "COMPLETED",
          conclusion: "STARTUP_FAILURE",
        },
        { __typename: "CheckRun", status: "COMPLETED", conclusion: "STALE" },
        { __typename: "CheckRun", status: "IN_PROGRESS" },
      ]),
    );
    expect(runs.map((r) => r.conclusion)).toEqual(["failure", "neutral", null]);
    expect(runs.map((r) => r.state)).toEqual([
      "completed",
      "completed",
      "running",
    ]);
  });

  it("is empty with no rollup at all", () => {
    expect(mapChecks({})).toEqual([]);
  });
});

describe("mapDetail", () => {
  const base: RawGraphqlChangeRequest = {
    number: 9,
    title: "t",
    body: "b",
    state: "OPEN",
    url: "https://github.com/acme/site/pull/9",
    baseRefName: "main",
    headRefName: "feat/x",
    headRefOid: "abc1234",
    author: { login: "someone" },
    mergeable: "MERGEABLE",
  };

  /**
   * `reviewBlocked` and `unresolvedConversations` are the point of the
   * detailed read: REST exposes neither, so the panel used to infer "blocked
   * on a human" from `mergeable_state` and count every review comment ever
   * left as an open conversation.
   */
  it("reports a missing approval as blocked on a person", () => {
    expect(
      mapDetail({ ...base, reviewDecision: "REVIEW_REQUIRED" }, REPO),
    ).toMatchObject({ reviewBlocked: true });
    expect(
      mapDetail({ ...base, reviewDecision: "CHANGES_REQUESTED" }, REPO),
    ).toMatchObject({ reviewBlocked: true });
    expect(
      mapDetail({ ...base, reviewDecision: "APPROVED" }, REPO),
    ).toMatchObject({ reviewBlocked: false });
  });

  it("counts only the review threads GitHub reports as unresolved", () => {
    expect(
      mapDetail(
        {
          ...base,
          reviewThreads: {
            nodes: [
              { isResolved: false },
              { isResolved: true },
              { isResolved: false },
            ],
          },
        },
        REPO,
      ).unresolvedConversations,
    ).toBe(2);
  });

  it("states mergeability directly — there is no mergeable_state here", () => {
    expect(
      mapDetail({ ...base, mergeable: "CONFLICTING" }, REPO).conflicting,
    ).toBe(true);
    expect(
      mapDetail({ ...base, mergeable: "UNKNOWN" }, REPO).conflicting,
    ).toBeNull();
    expect(
      mapDetail({ ...base, state: "CLOSED", mergeable: "UNKNOWN" }, REPO)
        .conflicting,
    ).toBe(false);
  });

  it("splits merged out of closed, which GraphQL reports separately", () => {
    expect(
      mapDetail({ ...base, state: "CLOSED", merged: true }, REPO).state,
    ).toBe("merged");
    expect(mapDetail({ ...base, state: "CLOSED" }, REPO).state).toBe("closed");
  });

  /** A sticky comment's edit time is what ranks it — see `previewUrlFromComments`. */
  it("carries a comment's edit time, falling back to its creation", () => {
    const [edited, never] = mapDetail(
      {
        ...base,
        comments: {
          nodes: [
            {
              databaseId: 1,
              body: "a",
              createdAt: "2026-08-01T00:00:00Z",
              updatedAt: "2026-08-06T00:00:00Z",
            },
            { databaseId: 2, body: "b", createdAt: "2026-08-03T00:00:00Z" },
          ],
        },
      },
      REPO,
    ).comments;
    expect(edited?.updatedAt).toBe("2026-08-06T00:00:00Z");
    expect(never?.updatedAt).toBe("2026-08-03T00:00:00Z");
  });

  it("falls back to a built URL when GraphQL reports none", () => {
    expect(mapDetail({ ...base, url: null }, REPO).url).toBe(
      "https://github.com/acme/site/pull/9",
    );
  });
});

describe("pickMostRecentlyMerged", () => {
  /**
   * The page is ordered by `updatedAt`, and the two diverge whenever an older
   * merged pull request was touched (a comment, a label) more recently than a
   * newer merge landed — so position cannot be trusted.
   */
  it("takes the max mergedAt, not the first node", () => {
    expect(
      pickMostRecentlyMerged([
        { number: 1, mergedAt: "2026-08-01T00:00:00Z" },
        { number: 2, mergedAt: "2026-09-01T00:00:00Z" },
        { number: 3, mergedAt: "2026-07-01T00:00:00Z" },
      ])?.number,
    ).toBe(2);
  });

  it("ignores nodes with no usable merge time", () => {
    expect(
      pickMostRecentlyMerged([{ number: 1 }, { number: 2, mergedAt: "nope" }]),
    ).toBeNull();
    expect(pickMostRecentlyMerged([])).toBeNull();
    expect(pickMostRecentlyMerged(null)).toBeNull();
  });
});

describe("isMergeMethodNotAllowed", () => {
  /** The refusal a repository gives when it forbids the method just tried. */
  it("is true for the forbidden-method refusal, for each method", () => {
    for (const detail of [
      "GitHub change_request_merge failed: 405 Merge commits are not allowed on this repository.",
      "405 Squash merges are not allowed on this repository",
      "405 Rebase merges are not allowed on this repository",
    ]) {
      expect(isMergeMethodNotAllowed(detail)).toBe(true);
    }
  });

  /** A conflict is also a 405, but no other method fixes it — must not advance. */
  it("is false for a 405 that is not about the method", () => {
    expect(isMergeMethodNotAllowed("405 Pull Request is not mergeable")).toBe(
      false,
    );
    expect(isMergeMethodNotAllowed("405 Method Not Allowed")).toBe(false);
  });

  it("is false for every other refusal", () => {
    expect(isMergeMethodNotAllowed("409 Merge conflict")).toBe(false);
    expect(
      isMergeMethodNotAllowed(
        "422 At least 1 approving review is required by reviewers with write access",
      ),
    ).toBe(false);
    expect(isMergeMethodNotAllowed("")).toBe(false);
  });
});
