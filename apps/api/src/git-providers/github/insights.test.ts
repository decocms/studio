import { describe, expect, test } from "bun:test";
import {
  commitHistoryQuery,
  type GithubPullRequestNode,
  mapCommit,
  mapPullRequest,
  mapSearchResults,
  mapTreeEntries,
  pullRequestsQuery,
  pullRequestStates,
  withinUpdatedWindow,
} from "./insights";

/** A merged pull request with everything the expensive selections add. */
function pullRequestNode(
  overrides: Partial<GithubPullRequestNode> = {},
): GithubPullRequestNode {
  return {
    number: 12,
    title: "Ship the checkout redesign",
    url: "https://github.com/acme/storefront/pull/12",
    state: "MERGED",
    createdAt: "2026-02-01T10:00:00Z",
    updatedAt: "2026-02-04T09:00:00Z",
    mergedAt: "2026-02-03T18:00:00Z",
    closedAt: "2026-02-03T18:00:00Z",
    baseRefName: "main",
    headRefName: "feat/checkout",
    additions: 120,
    deletions: 30,
    author: { login: "ana", __typename: "User" },
    commits: {
      totalCount: 2,
      nodes: [
        { commit: { oid: "sha-1", committedDate: "2026-02-01T11:00:00Z" } },
        { commit: { oid: "sha-2", committedDate: "2026-02-02T11:00:00Z" } },
      ],
    },
    ...overrides,
  };
}

describe("pullRequestStates", () => {
  test("a state filter becomes GraphQL's enum list", () => {
    expect(pullRequestStates("merged")).toEqual(["MERGED"]);
    expect(pullRequestStates("open")).toEqual(["OPEN"]);
  });

  test("'all' omits the argument rather than enumerating states", () => {
    expect(pullRequestStates("all")).toBeNull();
  });
});

describe("pullRequestsQuery", () => {
  test("the cheap read asks for neither commits nor line stats", () => {
    const query = pullRequestsQuery({
      includeCommits: false,
      includeStats: false,
    });
    expect(query).not.toContain("commits(");
    expect(query).not.toContain("additions");
    expect(query).not.toContain("deletions");
  });

  test("each expensive selection is added only when asked for", () => {
    const stats = pullRequestsQuery({
      includeCommits: false,
      includeStats: true,
    });
    expect(stats).toContain("additions");
    expect(stats).not.toContain("commits(");

    const commits = pullRequestsQuery({
      includeCommits: true,
      includeStats: false,
    });
    expect(commits).toContain("commits(first: 100)");
    expect(commits).not.toContain("additions");
  });

  test("every shape keeps the ordering the window walk depends on", () => {
    for (const includeCommits of [true, false]) {
      for (const includeStats of [true, false]) {
        const query = pullRequestsQuery({ includeCommits, includeStats });
        expect(query).toContain(
          "orderBy: { field: UPDATED_AT, direction: DESC }",
        );
        expect(query).toContain("author { login __typename }");
      }
    }
  });
});

describe("commitHistoryQuery", () => {
  test("no ref reads the default branch and declares no $ref variable", () => {
    const query = commitHistoryQuery(false);
    expect(query).toContain("defaultBranchRef");
    expect(query).not.toContain("$ref");
  });

  test("a named ref is a variable, never interpolated into the query", () => {
    const query = commitHistoryQuery(true);
    expect(query).toContain("$ref: String!");
    expect(query).toContain("ref(qualifiedName: $ref)");
    expect(query).not.toContain("defaultBranchRef");
  });

  test("both shapes select the author email the histogram keys on", () => {
    for (const hasRef of [true, false]) {
      expect(commitHistoryQuery(hasRef)).toContain(
        "author { name email user { login } }",
      );
    }
  });
});

describe("mapPullRequest", () => {
  test("a merged pull request keeps its dates, branches and stats", () => {
    expect(mapPullRequest(pullRequestNode())).toEqual({
      number: 12,
      title: "Ship the checkout redesign",
      url: "https://github.com/acme/storefront/pull/12",
      state: "merged",
      author: { login: "ana", isBot: false },
      createdAt: "2026-02-01T10:00:00Z",
      updatedAt: "2026-02-04T09:00:00Z",
      mergedAt: "2026-02-03T18:00:00Z",
      closedAt: "2026-02-03T18:00:00Z",
      base: "main",
      head: "feat/checkout",
      additions: 120,
      deletions: 30,
      commits: {
        count: 2,
        items: [
          { sha: "sha-1", date: "2026-02-01T11:00:00Z" },
          { sha: "sha-2", date: "2026-02-02T11:00:00Z" },
        ],
      },
    });
  });

  test("GitHub's three states map onto the neutral three", () => {
    expect(mapPullRequest(pullRequestNode({ state: "OPEN" })).state).toBe(
      "open",
    );
    expect(mapPullRequest(pullRequestNode({ state: "CLOSED" })).state).toBe(
      "closed",
    );
    expect(mapPullRequest(pullRequestNode({ state: "MERGED" })).state).toBe(
      "merged",
    );
  });

  test("a Bot actor is a bot even when its login says nothing", () => {
    const node = pullRequestNode({
      author: { login: "acme-deploy", __typename: "Bot" },
    });
    expect(mapPullRequest(node).author).toEqual({
      login: "acme-deploy",
      isBot: true,
    });
  });

  test("a login that names a bot is one even when GitHub typed it as a User", () => {
    const node = pullRequestNode({
      author: { login: "renovate[bot]", __typename: "User" },
    });
    expect(mapPullRequest(node).author.isBot).toBe(true);
  });

  test("an unasked-for selection is null, never zero or an empty list", () => {
    const node = pullRequestNode({
      additions: undefined,
      deletions: undefined,
      commits: undefined,
    });
    const item = mapPullRequest(node);
    expect(item.additions).toBeNull();
    expect(item.deletions).toBeNull();
    expect(item.commits).toBeNull();
  });

  test("a deleted author leaves an empty login rather than crashing the row", () => {
    expect(mapPullRequest(pullRequestNode({ author: null })).author).toEqual({
      login: "",
      isBot: false,
    });
  });

  test("a commit node missing its oid is dropped, not mapped as an empty sha", () => {
    const node = pullRequestNode({
      commits: {
        totalCount: 3,
        nodes: [
          { commit: { oid: "sha-1", committedDate: "2026-02-01T11:00:00Z" } },
          { commit: {} },
          {},
        ],
      },
    });
    expect(mapPullRequest(node).commits).toEqual({
      count: 3,
      items: [{ sha: "sha-1", date: "2026-02-01T11:00:00Z" }],
    });
  });
});

describe("mapCommit", () => {
  test("name, email and login all survive the mapping", () => {
    expect(
      mapCommit({
        oid: "abc123",
        committedDate: "2026-02-01T11:00:00Z",
        messageHeadline: "fix(cart): keep the coupon on reload",
        author: {
          name: "Ana",
          email: "ana@example.com",
          user: { login: "ana" },
        },
      }),
    ).toEqual({
      sha: "abc123",
      date: "2026-02-01T11:00:00Z",
      message: "fix(cart): keep the coupon on reload",
      author: { name: "Ana", email: "ana@example.com", login: "ana" },
    });
  });

  test("an unattributed commit keeps its email and reports no login", () => {
    expect(
      mapCommit({
        oid: "abc123",
        committedDate: "2026-02-01T11:00:00Z",
        author: { name: "Ana", email: "ana@example.com", user: null },
      }).author,
    ).toEqual({ name: "Ana", email: "ana@example.com", login: null });
  });

  test("an absent author is three nulls, not an empty string", () => {
    expect(
      mapCommit({
        oid: "abc123",
        committedDate: "2026-02-01T11:00:00Z",
        author: null,
      }).author,
    ).toEqual({ name: null, email: null, login: null });
  });
});

describe("withinUpdatedWindow", () => {
  const items = [
    mapPullRequest(
      pullRequestNode({ number: 3, updatedAt: "2026-03-01T00:00:00Z" }),
    ),
    mapPullRequest(
      pullRequestNode({ number: 2, updatedAt: "2026-02-01T00:00:00Z" }),
    ),
    mapPullRequest(
      pullRequestNode({ number: 1, updatedAt: "2026-01-01T00:00:00Z" }),
    ),
  ];

  test("without a window every row is kept and the walk continues", () => {
    expect(withinUpdatedWindow(items, undefined)).toEqual({
      items,
      reachedWindowEnd: false,
    });
  });

  test("the first row outside the window ends the walk", () => {
    const result = withinUpdatedWindow(items, "2026-02-01T00:00:00Z");
    expect(result.items.map((item) => item.number)).toEqual([3, 2]);
    expect(result.reachedWindowEnd).toBe(true);
  });

  test("a page entirely inside the window does not end the walk", () => {
    const result = withinUpdatedWindow(items, "2025-01-01T00:00:00Z");
    expect(result.items).toHaveLength(3);
    expect(result.reachedWindowEnd).toBe(false);
  });

  test("an unparseable window is ignored rather than emptying the page", () => {
    expect(withinUpdatedWindow(items, "last tuesday")).toEqual({
      items,
      reachedWindowEnd: false,
    });
  });
});

describe("mapTreeEntries", () => {
  test("blobs and trees map; submodules and commit entries do not", () => {
    expect(
      mapTreeEntries(
        {
          tree: [
            { path: "src/index.ts", type: "blob", size: 120 },
            { path: "src", type: "tree" },
            { path: "vendor/lib", type: "commit" },
            { type: "blob" },
          ],
        },
        100,
      ),
    ).toEqual({
      entries: [
        { path: "src/index.ts", type: "blob", size: 120 },
        { path: "src", type: "tree" },
      ],
      truncated: false,
    });
  });

  test("GitHub's own truncation is reported even under the cap", () => {
    expect(
      mapTreeEntries(
        { tree: [{ path: "a", type: "blob" }], truncated: true },
        100,
      ).truncated,
    ).toBe(true);
  });

  test("the cap truncates and stops mapping the rest", () => {
    const tree = Array.from({ length: 10 }, (_, index) => ({
      path: `file-${index}.ts`,
      type: "blob" as const,
    }));
    const result = mapTreeEntries({ tree }, 3);
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  test("an empty tree is an empty listing, not a truncated one", () => {
    expect(mapTreeEntries({ tree: [] }, 100)).toEqual({
      entries: [],
      truncated: false,
    });
  });
});

describe("mapSearchResults", () => {
  test("hits carry the first text match as the fragment", () => {
    expect(
      mapSearchResults({
        incomplete_results: false,
        items: [
          {
            path: "src/checkout.ts",
            text_matches: [{ fragment: "const checkout = () => {" }],
          },
          { path: "src/cart.ts" },
        ],
      }),
    ).toEqual({
      supported: true,
      incomplete: false,
      hits: [
        { path: "src/checkout.ts", fragment: "const checkout = () => {" },
        { path: "src/cart.ts" },
      ],
    });
  });

  test("GitHub giving up early is reported, not hidden", () => {
    expect(
      mapSearchResults({ incomplete_results: true, items: [] }).incomplete,
    ).toBe(true);
  });

  test("no matches is still a supported search", () => {
    expect(mapSearchResults({})).toEqual({
      supported: true,
      incomplete: false,
      hits: [],
    });
  });
});
