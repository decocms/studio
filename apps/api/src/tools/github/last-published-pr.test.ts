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
