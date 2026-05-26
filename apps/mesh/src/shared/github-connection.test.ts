import { describe, expect, test } from "bun:test";
import {
  encodeMeshOAuthClientState,
  getGithubConnectionRepoScope,
  githubConnectionTitle,
  isGithubMcpConnection,
} from "./github-connection";
import {
  isGithubMcpConnectionUrl,
  isLocalGithubMcpUrl,
} from "./github-mcp-url";

describe("github-connection", () => {
  test("isGithubMcpConnection matches app_name and canonical URL", () => {
    expect(isGithubMcpConnection({ app_name: "mcp-github" })).toBe(true);
    expect(
      isGithubMcpConnection({
        connection_url: "https://github-mcp.decocms.com/mcp",
      }),
    ).toBe(true);
    expect(
      isGithubMcpConnection({
        connection_url: "http://localhost:8787/api/mcp",
      }),
    ).toBe(true);
    expect(isGithubMcpConnection({ app_name: "other" })).toBe(false);
  });

  test("getGithubConnectionRepoScope reads repositoryId from metadata", () => {
    expect(
      getGithubConnectionRepoScope({
        githubRepo: {
          owner: "deco",
          name: "mesh",
          url: "https://github.com/deco/mesh",
          repositoryId: 123,
          installationId: 456,
        },
      }),
    ).toEqual({
      owner: "deco",
      name: "mesh",
      url: "https://github.com/deco/mesh",
      repositoryId: 123,
      installationId: 456,
    });
  });

  test("encodeMeshOAuthClientState round-trips repositoryId", () => {
    const encoded = encodeMeshOAuthClientState({ repositoryId: 99 });
    expect(encoded.startsWith("mesh:")).toBe(true);
  });

  test("githubConnectionTitle formats owner/repo", () => {
    expect(githubConnectionTitle("deco", "mesh")).toBe("GitHub — deco/mesh");
  });
});

describe("github-mcp-url", () => {
  test("isLocalGithubMcpUrl detects localhost", () => {
    expect(isLocalGithubMcpUrl("http://localhost:8787/api/mcp")).toBe(true);
    expect(isLocalGithubMcpUrl("https://github-mcp.decocms.com/mcp")).toBe(
      false,
    );
  });

  test("isGithubMcpConnectionUrl accepts local and prod hosts", () => {
    expect(isGithubMcpConnectionUrl("http://localhost:8787/mcp")).toBe(true);
    expect(isGithubMcpConnectionUrl("http://localhost:8787/api/mcp")).toBe(
      true,
    );
    expect(isGithubMcpConnectionUrl("https://github-mcp.decocms.com/mcp")).toBe(
      true,
    );
  });
});
