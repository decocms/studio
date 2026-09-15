import { describe, expect, test } from "bun:test";
import {
  type GitlabMergeRequestRow,
  mapCommit,
  mapMergeRequest,
  mapMergeRequestState,
  mapTreeRows,
  mergeRequestStateParam,
  nextPageCursor,
} from "./insights";

const fallbackUrl = (iid: number) =>
  `https://gitlab.example.dev/group/sub/project/-/merge_requests/${iid}`;

function mergeRequestRow(
  overrides: Partial<GitlabMergeRequestRow> = {},
): GitlabMergeRequestRow {
  return {
    iid: 7,
    title: "Ship the checkout redesign",
    web_url: "https://gitlab.example.dev/group/sub/project/-/merge_requests/7",
    state: "merged",
    created_at: "2026-02-01T10:00:00Z",
    updated_at: "2026-02-04T09:00:00Z",
    merged_at: "2026-02-03T18:00:00Z",
    closed_at: null,
    target_branch: "main",
    source_branch: "feat/checkout",
    author: { username: "ana", bot: false },
    ...overrides,
  };
}

describe("mergeRequestStateParam", () => {
  test("GitLab calls an open merge request 'opened'", () => {
    expect(mergeRequestStateParam("open")).toBe("opened");
    expect(mergeRequestStateParam("merged")).toBe("merged");
  });

  test("'all' omits the parameter", () => {
    expect(mergeRequestStateParam("all")).toBeNull();
  });
});

describe("mapMergeRequestState", () => {
  test("GitLab's vocabulary maps onto the neutral three", () => {
    expect(mapMergeRequestState("merged")).toBe("merged");
    expect(mapMergeRequestState("closed")).toBe("closed");
    expect(mapMergeRequestState("opened")).toBe("open");
  });

  test("a state GitLab added since (locked) is not read as closed", () => {
    expect(mapMergeRequestState("locked")).toBe("open");
    expect(mapMergeRequestState(undefined)).toBe("open");
  });
});

describe("mapMergeRequest", () => {
  test("a merged merge request keeps its dates and branches", () => {
    expect(mapMergeRequest(mergeRequestRow(), fallbackUrl)).toEqual({
      number: 7,
      title: "Ship the checkout redesign",
      url: "https://gitlab.example.dev/group/sub/project/-/merge_requests/7",
      state: "merged",
      author: { login: "ana", isBot: false },
      createdAt: "2026-02-01T10:00:00Z",
      updatedAt: "2026-02-04T09:00:00Z",
      mergedAt: "2026-02-03T18:00:00Z",
      closedAt: null,
      base: "main",
      head: "feat/checkout",
      additions: null,
      deletions: null,
      commits: null,
    });
  });

  test("line stats are null rather than zero — GitLab does not expose them cheaply", () => {
    const item = mapMergeRequest(mergeRequestRow(), fallbackUrl);
    expect(item.additions).toBeNull();
    expect(item.deletions).toBeNull();
  });

  test("GitLab's own bot flag wins, and a bot-looking login is caught too", () => {
    expect(
      mapMergeRequest(
        mergeRequestRow({ author: { username: "acme-deploy", bot: true } }),
        fallbackUrl,
      ).author,
    ).toEqual({ login: "acme-deploy", isBot: true });
    expect(
      mapMergeRequest(
        mergeRequestRow({ author: { username: "renovate", bot: false } }),
        fallbackUrl,
      ).author.isBot,
    ).toBe(true);
  });

  test("a row without a web_url falls back to the computed one", () => {
    expect(
      mapMergeRequest(mergeRequestRow({ web_url: undefined }), fallbackUrl).url,
    ).toBe("https://gitlab.example.dev/group/sub/project/-/merge_requests/7");
  });

  test("an absent updated_at falls back to creation, never to an empty date", () => {
    expect(
      mapMergeRequest(mergeRequestRow({ updated_at: undefined }), fallbackUrl)
        .updatedAt,
    ).toBe("2026-02-01T10:00:00Z");
  });
});

describe("mapCommit", () => {
  test("the author email GitLab carries on the commit survives", () => {
    expect(
      mapCommit({
        id: "abc123",
        committed_date: "2026-02-01T11:00:00Z",
        title: "fix(cart): keep the coupon on reload",
        author_name: "Ana",
        author_email: "ana@example.com",
      }),
    ).toEqual({
      sha: "abc123",
      date: "2026-02-01T11:00:00Z",
      message: "fix(cart): keep the coupon on reload",
      author: { name: "Ana", email: "ana@example.com", login: null },
    });
  });

  test("without a title the subject is the message's first line, not the whole body", () => {
    expect(
      mapCommit({
        id: "abc123",
        committed_date: "2026-02-01T11:00:00Z",
        message: "fix(cart): keep the coupon\n\nlonger explanation",
      }).message,
    ).toBe("fix(cart): keep the coupon");
  });
});

describe("nextPageCursor", () => {
  test("the header GitLab sets becomes the cursor", () => {
    expect(nextPageCursor(new Headers({ "x-next-page": "3" }))).toBe("3");
  });

  test("the last page sends an empty header, which is the end of the walk", () => {
    expect(nextPageCursor(new Headers({ "x-next-page": "" }))).toBeNull();
    expect(nextPageCursor(new Headers())).toBeNull();
  });

  test("a non-numeric header ends the walk rather than paging into nothing", () => {
    expect(nextPageCursor(new Headers({ "x-next-page": "next" }))).toBeNull();
  });
});

describe("mapTreeRows", () => {
  test("directories and files are distinguished by GitLab's type", () => {
    expect(
      mapTreeRows([
        { path: "src", type: "tree" },
        { path: "src/index.ts", type: "blob" },
      ]),
    ).toEqual([
      { path: "src", type: "tree" },
      { path: "src/index.ts", type: "blob" },
    ]);
  });

  test("a row without a path is dropped", () => {
    expect(mapTreeRows([{ type: "blob" }])).toEqual([]);
  });
});
