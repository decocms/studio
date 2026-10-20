import { describe, expect, test } from "bun:test";
import {
  readRepositoryMetadata,
  writeRepositoryMetadata,
} from "./repository-metadata";

const repo = {
  owner: "group/subgroup",
  name: "site",
  url: "https://gitlab.com/group/subgroup/site",
  repositoryId: "repo_example",
};

describe("repository metadata database compatibility", () => {
  test("exposes only canonical keys from historical rows", () => {
    expect(
      readRepositoryMetadata({
        githubRepo: repo,
        githubRepos: [repo],
        source: "example",
      }),
    ).toEqual({
      repository: repo,
      additionalRepositories: [repo],
      source: "example",
    });
  });

  test("writes only the physical keys understood by older replicas", () => {
    const bytes = JSON.stringify(
      writeRepositoryMetadata({
        repository: repo,
        additionalRepositories: [repo],
        source: "example",
      }),
    );
    expect(JSON.parse(bytes)).toEqual({
      githubRepo: repo,
      githubRepos: [repo],
      source: "example",
    });
    expect(bytes).not.toContain('"repository":');
    expect(bytes).not.toContain('"additionalRepositories":');
    expect(readRepositoryMetadata(JSON.parse(bytes))?.repository).toEqual(repo);
  });

  test("clears a binding without reviving stale alternate keys", () => {
    const metadata = {
      repository: null,
      additionalRepositories: [],
      githubRepo: repo,
      githubRepos: [repo],
    };
    expect(readRepositoryMetadata(metadata)).toEqual({
      repository: null,
      additionalRepositories: [],
    });
    expect(writeRepositoryMetadata(readRepositoryMetadata(metadata))).toEqual({
      githubRepo: null,
      githubRepos: [],
    });
    expect(() =>
      writeRepositoryMetadata({ source: "example", githubRepo: repo }),
    ).toThrow("database compatibility key");
  });

  test("observes an older replica's replacement and removal", () => {
    const stored = writeRepositoryMetadata({ repository: repo })!;
    const replacement = {
      ...repo,
      url: "https://bitbucket.org/workspace/site",
      owner: "workspace",
    };
    stored.githubRepo = replacement;
    expect(readRepositoryMetadata(stored)?.repository).toEqual(replacement);
    delete stored.githubRepo;
    expect(readRepositoryMetadata(stored)).toEqual({});
  });

  test("rejects malformed shapes without inventing a binding", () => {
    for (const value of [null, undefined, [], "invalid", 2])
      expect(readRepositoryMetadata(value)).toBeNull();
    expect(
      readRepositoryMetadata({
        githubRepo: { owner: "group/subgroup", name: "site" },
        githubRepos: [null, {}, repo],
      }),
    ).toEqual({ repository: null, additionalRepositories: [repo] });
    expect(readRepositoryMetadata({ githubRepos: null })).toEqual({
      additionalRepositories: null,
    });
  });

  test("recovers old GitHub bindings that predate URLs at the database boundary", () => {
    expect(
      readRepositoryMetadata({ githubRepo: { owner: "example", name: "site" } })
        ?.repository,
    ).toEqual({
      owner: "example",
      name: "site",
      url: "https://github.com/example/site",
    });
  });
  test("strips embedded credentials from persisted bytes and refuses malformed URLs", () => {
    const bytes = JSON.stringify(
      writeRepositoryMetadata({
        repository: {
          ...repo,
          url: "https://user:synthetic-secret@gitlab.com/group/site?token=synthetic-token#private",
        },
      }),
    );
    expect(bytes).not.toContain("synthetic-secret");
    expect(bytes).not.toContain("synthetic-token");
    expect(JSON.parse(bytes).githubRepo.url).toBe(
      "https://gitlab.com/group/site",
    );
    expect(() =>
      writeRepositoryMetadata({ repository: { ...repo, url: "not a URL" } }),
    ).toThrow();
  });
});
