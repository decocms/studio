import { describe, expect, it } from "bun:test";
import { isGithubConnection } from "@/oauth/github-mint";
import { parseBranchSearchResponse } from "./search-branches";

const REPO = "acme/site";

describe("parseBranchSearchResponse", () => {
  it("maps refs to branches with their author", () => {
    const result = parseBranchSearchResponse(
      {
        repository: {
          refs: {
            totalCount: 2,
            nodes: [
              {
                name: "feat/search",
                target: { author: { user: { login: "gimenes" } } },
              },
              {
                name: "main",
                target: { author: { user: { login: "octocat" } } },
              },
            ],
          },
        },
      },
      REPO,
    );

    expect(result).toEqual({
      branches: [
        { name: "feat/search", author: "gimenes" },
        { name: "main", author: "octocat" },
      ],
      totalCount: 2,
    });
  });

  it("nulls the author when the committer has no linked GitHub account", () => {
    const result = parseBranchSearchResponse(
      {
        repository: {
          refs: {
            totalCount: 1,
            nodes: [{ name: "fix-workspace-wallet", target: { author: {} } }],
          },
        },
      },
      REPO,
    );

    expect(result.branches).toEqual([
      { name: "fix-workspace-wallet", author: null },
    ]);
  });

  it("nulls the author when the ref target is not a Commit", () => {
    const result = parseBranchSearchResponse(
      { repository: { refs: { totalCount: 1, nodes: [{ name: "odd" }] } } },
      REPO,
    );

    expect(result.branches).toEqual([{ name: "odd", author: null }]);
  });

  it("keeps totalCount above the returned page so callers can report the rest", () => {
    const result = parseBranchSearchResponse(
      {
        repository: { refs: { totalCount: 195, nodes: [{ name: "fix-ui" }] } },
      },
      REPO,
    );

    expect(result.totalCount).toBe(195);
    expect(result.branches).toHaveLength(1);
  });

  it("returns an empty result when nothing matched", () => {
    const result = parseBranchSearchResponse(
      { repository: { refs: { totalCount: 0, nodes: [] } } },
      REPO,
    );

    expect(result).toEqual({ branches: [], totalCount: 0 });
  });

  it("throws when the repository is hidden, naming the repo", () => {
    expect(() => parseBranchSearchResponse({ repository: null }, REPO)).toThrow(
      /acme\/site not found or not accessible/,
    );
  });
});

/**
 * The handler will not hand a connection's decrypted token to github.com
 * unless it is a GitHub connection — otherwise any OAuth connection id in the
 * caller's org would ship that provider's credential to an unrelated vendor.
 */
describe("isGithubConnection", () => {
  it("accepts the mcp-github slug every GitHub flow already filters on", () => {
    expect(isGithubConnection({ slug: "mcp-github" })).toBe(true);
  });

  it("rejects another provider's connection", () => {
    expect(isGithubConnection({ slug: "mcp-slack" })).toBe(false);
    expect(isGithubConnection({ slug: "mcp-jira" })).toBe(false);
  });

  it("rejects a connection with no slug", () => {
    expect(isGithubConnection({})).toBe(false);
    expect(isGithubConnection({ slug: null })).toBe(false);
  });
});
