import { describe, expect, test } from "bun:test";
import type { ReportsRepositoryRef } from "@decocms/shared/reports/repository-ref";
import {
  agentRepoBinding,
  nextConfigurationState,
  withoutStaleRepoConnection,
} from "./set-repository";

const github: ReportsRepositoryRef = {
  repositoryId: "repo_gh",
  provider: "github",
  host: "github.com",
  path: "acme/storefront",
  defaultBranch: "main",
  webUrl: "https://github.com/acme/storefront",
};

const gitlab: ReportsRepositoryRef = {
  repositoryId: "repo_gl",
  provider: "gitlab",
  host: "gitlab.example.dev",
  path: "group/sub/project",
  defaultBranch: null,
  webUrl: null,
};

describe("nextConfigurationState", () => {
  test("a github.com pick is written under both spellings", () => {
    const state = nextConfigurationState({ siteUrl: "shop.example" }, github);
    expect(state.github_repo).toBe("acme/storefront");
    expect(state.repository).toMatchObject({
      repository_id: "repo_gh",
      path: "acme/storefront",
    });
  });

  test("everything else the MCP put there survives", () => {
    const state = nextConfigurationState(
      { siteUrl: "shop.example", ga4: { propertyId: "1" } },
      github,
    );
    expect(state.siteUrl).toBe("shop.example");
    expect(state.ga4).toEqual({ propertyId: "1" });
  });

  test("moving to GitLab drops the legacy string instead of leaving it stale", () => {
    const state = nextConfigurationState(
      { github_repo: "acme/storefront" },
      gitlab,
    );
    expect(state.github_repo).toBeUndefined();
    expect(state.repository).toMatchObject({
      provider: "gitlab",
      path: "group/sub/project",
    });
  });

  test("clearing removes both spellings and keeps the rest", () => {
    const state = nextConfigurationState(
      {
        siteUrl: "shop.example",
        github_repo: "acme/storefront",
        repository: { repository_id: "repo_gh" },
      },
      null,
    );
    expect(state).toEqual({ siteUrl: "shop.example" });
  });
});

describe("agentRepoBinding", () => {
  test("a nested namespace stays in the owner, so the path round-trips", () => {
    expect(agentRepoBinding(gitlab)).toEqual({
      owner: "group/sub",
      name: "project",
      url: "https://gitlab.example.dev/group/sub/project",
      repositoryId: "repo_gl",
    });
  });

  test("the provider's own web url is used when the repository has one", () => {
    expect(agentRepoBinding(github).url).toBe(
      "https://github.com/acme/storefront",
    );
  });

  test("the binding names no connection — the repository's account is the credential", () => {
    expect(agentRepoBinding(github)).not.toHaveProperty("connectionId");
  });
});

describe("withoutStaleRepoConnection", () => {
  const connections = [
    { connection_id: "conn_repo_scoped" },
    { connection_id: "conn_analytics" },
  ];

  test("the previous binding's repo-scoped connection is dropped", () => {
    expect(withoutStaleRepoConnection(connections, "conn_repo_scoped")).toEqual(
      [{ connection_id: "conn_analytics" }],
    );
  });

  test("a binding that named no connection leaves the list alone", () => {
    expect(withoutStaleRepoConnection(connections, null)).toEqual(connections);
  });

  test("a connection the agent does not have is not an error", () => {
    expect(withoutStaleRepoConnection(connections, "conn_gone")).toEqual(
      connections,
    );
  });
});
