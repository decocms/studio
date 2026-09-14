import { describe, expect, test } from "bun:test";
import {
  type BitbucketPullRequestRow,
  mapCommit,
  mapPullRequest,
  mapPullRequestState,
  mapSearchRows,
  mapSrcRows,
  nextPageToken,
  parseRawAuthor,
  pullRequestStateParams,
} from "./insights";

const fallbackUrl = (id: number) =>
  `https://bitbucket.org/acme/storefront/pull-requests/${id}`;

function pullRequestRow(
  overrides: Partial<BitbucketPullRequestRow> = {},
): BitbucketPullRequestRow {
  return {
    id: 7,
    title: "Ship the checkout redesign",
    state: "MERGED",
    created_on: "2026-02-01T10:00:00Z",
    updated_on: "2026-02-04T09:00:00Z",
    links: {
      html: { href: "https://bitbucket.org/acme/storefront/pull-requests/7" },
    },
    source: { branch: { name: "feat/checkout" } },
    destination: { branch: { name: "main" } },
    author: { nickname: "ana", display_name: "Ana Souza" },
    merge_commit: { hash: "merge-sha" },
    ...overrides,
  };
}

describe("pullRequestStateParams", () => {
  test("a single state is sent as itself", () => {
    expect(pullRequestStateParams("merged")).toEqual(["MERGED"]);
    expect(pullRequestStateParams("open")).toEqual(["OPEN"]);
  });

  test("'all' names every state, because Bitbucket's default is OPEN alone", () => {
    expect(pullRequestStateParams("all")).toEqual([
      "OPEN",
      "MERGED",
      "DECLINED",
      "SUPERSEDED",
    ]);
  });
});

describe("mapPullRequestState", () => {
  test("Bitbucket's four states collapse onto the neutral three", () => {
    expect(mapPullRequestState("MERGED")).toBe("merged");
    expect(mapPullRequestState("OPEN")).toBe("open");
    expect(mapPullRequestState("DECLINED")).toBe("closed");
    expect(mapPullRequestState("SUPERSEDED")).toBe("closed");
  });
});

describe("mapPullRequest", () => {
  test("a merged pull request reports no merge time — Bitbucket does not carry one", () => {
    const item = mapPullRequest(pullRequestRow(), fallbackUrl);
    expect(item.state).toBe("merged");
    expect(item.mergedAt).toBeNull();
    expect(item.updatedAt).toBe("2026-02-04T09:00:00Z");
  });

  test("branches, title and url survive the mapping", () => {
    expect(mapPullRequest(pullRequestRow(), fallbackUrl)).toEqual({
      number: 7,
      title: "Ship the checkout redesign",
      url: "https://bitbucket.org/acme/storefront/pull-requests/7",
      state: "merged",
      author: { login: "ana", isBot: false },
      createdAt: "2026-02-01T10:00:00Z",
      updatedAt: "2026-02-04T09:00:00Z",
      mergedAt: null,
      closedAt: null,
      base: "main",
      head: "feat/checkout",
      additions: null,
      deletions: null,
      commits: null,
    });
  });

  test("an account without a nickname falls back to its display name", () => {
    expect(
      mapPullRequest(
        pullRequestRow({ author: { display_name: "Ana Souza" } }),
        fallbackUrl,
      ).author.login,
    ).toBe("Ana Souza");
  });

  test("a bot-looking login is flagged — Bitbucket has no bot field of its own", () => {
    expect(
      mapPullRequest(
        pullRequestRow({ author: { nickname: "renovate" } }),
        fallbackUrl,
      ).author.isBot,
    ).toBe(true);
  });

  test("a row without an html link falls back to the computed url", () => {
    expect(
      mapPullRequest(pullRequestRow({ links: null }), fallbackUrl).url,
    ).toBe("https://bitbucket.org/acme/storefront/pull-requests/7");
  });
});

describe("parseRawAuthor", () => {
  test("Bitbucket's raw git author line splits into name and email", () => {
    expect(parseRawAuthor("Ana Souza <ana@example.com>")).toEqual({
      name: "Ana Souza",
      email: "ana@example.com",
    });
  });

  test("a line with only an email keeps the email and reports no name", () => {
    expect(parseRawAuthor("<ana@example.com>")).toEqual({
      name: null,
      email: "ana@example.com",
    });
  });

  test("a line with no angle brackets is a name, not a malformed email", () => {
    expect(parseRawAuthor("Ana Souza")).toEqual({
      name: "Ana Souza",
      email: null,
    });
  });

  test("an absent line is two nulls", () => {
    expect(parseRawAuthor(null)).toEqual({ name: null, email: null });
    expect(parseRawAuthor(undefined)).toEqual({ name: null, email: null });
    expect(parseRawAuthor("")).toEqual({ name: null, email: null });
  });
});

describe("mapCommit", () => {
  test("the raw author line becomes name and email, and the nickname the login", () => {
    expect(
      mapCommit({
        hash: "abc123",
        date: "2026-02-01T11:00:00Z",
        message: "fix(cart): keep the coupon\n\nlonger explanation",
        author: {
          raw: "Ana Souza <ana@example.com>",
          user: { nickname: "ana" },
        },
      }),
    ).toEqual({
      sha: "abc123",
      date: "2026-02-01T11:00:00Z",
      message: "fix(cart): keep the coupon",
      author: { name: "Ana Souza", email: "ana@example.com", login: "ana" },
    });
  });

  test("a commit by someone without a Bitbucket account keeps its email", () => {
    expect(
      mapCommit({
        hash: "abc123",
        date: "2026-02-01T11:00:00Z",
        author: { raw: "Ana Souza <ana@example.com>", user: null },
      }).author,
    ).toEqual({ name: "Ana Souza", email: "ana@example.com", login: null });
  });
});

describe("nextPageToken", () => {
  test("a numeric page becomes the cursor", () => {
    expect(
      nextPageToken({ next: "https://api.bitbucket.org/2.0/x?page=3" }),
    ).toBe("3");
  });

  test("the opaque token the commits listing pages with is passed through verbatim", () => {
    expect(
      nextPageToken({ next: "https://api.bitbucket.org/2.0/x?page=abc123ctx" }),
    ).toBe("abc123ctx");
  });

  test("no next link is the end of the listing", () => {
    expect(nextPageToken({})).toBeNull();
    expect(nextPageToken({ next: null })).toBeNull();
  });

  test("an unparseable next link ends the walk rather than throwing mid-audit", () => {
    expect(nextPageToken({ next: "not a url" })).toBeNull();
    expect(
      nextPageToken({ next: "https://api.bitbucket.org/2.0/x" }),
    ).toBeNull();
  });
});

describe("mapSrcRows", () => {
  test("Bitbucket's own type names map onto blob and tree", () => {
    expect(
      mapSrcRows([
        { path: "src", type: "commit_directory" },
        { path: "src/index.ts", type: "commit_file", size: 120 },
      ]),
    ).toEqual([
      { path: "src", type: "tree" },
      { path: "src/index.ts", type: "blob", size: 120 },
    ]);
  });

  test("a row without a path is dropped", () => {
    expect(mapSrcRows([{ type: "commit_file" }])).toEqual([]);
  });
});

describe("mapSearchRows", () => {
  test("the matching segments join into one fragment", () => {
    expect(
      mapSearchRows([
        {
          file: { path: "src/checkout.ts" },
          content_matches: [
            {
              lines: [
                { segments: [{ text: "const " }, { text: "checkout" }] },
                { segments: [{ text: " = () => {" }] },
              ],
            },
          ],
        },
      ]),
    ).toEqual([
      { path: "src/checkout.ts", fragment: "const checkout = () => {" },
    ]);
  });

  test("a hit without an excerpt is still a hit", () => {
    expect(mapSearchRows([{ file: { path: "src/cart.ts" } }])).toEqual([
      { path: "src/cart.ts" },
    ]);
  });

  test("a row without a file path is dropped", () => {
    expect(mapSearchRows([{ file: null }, {}])).toEqual([]);
  });
});
