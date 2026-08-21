import { describe, expect, it } from "bun:test";
import { parseLastPublishedPr } from "./last-published-pr";

describe("parseLastPublishedPr", () => {
  it("maps the merged pull request", () => {
    const { pullRequest } = parseLastPublishedPr({
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 12,
              title: "Publish homepage copy",
              body: "",
              mergedAt: "2026-08-19T10:00:00Z",
              url: "https://github.com/acme/site/pull/12",
              baseRefName: "main",
              headRefName: "claude/copy",
              headRefOid: "def456",
              author: { login: "gimenes" },
            },
          ],
        },
      },
    });

    expect(pullRequest).toEqual({
      number: 12,
      title: "Publish homepage copy",
      body: "",
      mergedAt: "2026-08-19T10:00:00Z",
      base: "main",
      head: "claude/copy",
      headSha: "def456",
      htmlUrl: "https://github.com/acme/site/pull/12",
      author: "gimenes",
    });
  });

  /**
   * A page ordered by `updatedAt` can list a stale merged PR first (a
   * post-merge comment bumped its `updatedAt` past a newer merge) — the
   * result must still be the one with the latest `mergedAt`.
   */
  it("picks the max mergedAt, not the first node in the updatedAt-ordered page", () => {
    const { pullRequest } = parseLastPublishedPr({
      repository: {
        pullRequests: {
          nodes: [
            {
              number: 10,
              title: "Older publish, commented on recently",
              body: "",
              mergedAt: "2026-08-10T10:00:00Z",
              url: "https://github.com/acme/site/pull/10",
              baseRefName: "main",
              headRefName: "claude/old",
              headRefOid: "aaa111",
              author: { login: "gimenes" },
            },
            {
              number: 12,
              title: "Actually the last publish",
              body: "",
              mergedAt: "2026-08-19T10:00:00Z",
              url: "https://github.com/acme/site/pull/12",
              baseRefName: "main",
              headRefName: "claude/copy",
              headRefOid: "def456",
              author: { login: "gimenes" },
            },
          ],
        },
      },
    });

    expect(pullRequest?.number).toBe(12);
  });

  it("returns null when nothing was ever merged into the base", () => {
    expect(
      parseLastPublishedPr({ repository: { pullRequests: { nodes: [] } } }),
    ).toEqual({ pullRequest: null });
  });

  /** "Never published" and "not allowed to look" must not read the same. */
  it("throws when the repository is hidden", () => {
    expect(() => parseLastPublishedPr({ repository: null })).toThrow(
      /not found or not accessible/,
    );
  });
});
