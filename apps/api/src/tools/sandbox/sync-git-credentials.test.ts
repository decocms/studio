import { describe, expect, mock, test } from "bun:test";
import {
  encodeSandboxStartError,
  SANDBOX_START_ERROR_CODES,
} from "@decocms/shared/sandbox-start-errors";
import type { StudioContext } from "../../core/studio-context";
import type { SandboxProvider } from "@decocms/sandbox/provider";

mock.module("../../shared/github-clone-info", () => ({
  buildCloneInfo: mock(async () => {
    throw new Error(
      encodeSandboxStartError(
        SANDBOX_START_ERROR_CODES.githubConnectionMissing,
        "GitHub connection conn_1 no longer exists. Link acme/site again.",
      ),
    );
  }),
  ensureGithubCloneToken: mock(async () => {}),
}));

const {
  GitPushAuthError,
  parseGithubRepoFromMetadata,
  refreshSandboxGitCredentials,
} = await import("./sync-git-credentials");

describe("parseGithubRepoFromMetadata", () => {
  test("returns public-clone repo without connectionId", () => {
    const repo = parseGithubRepoFromMetadata(
      {
        githubRepo: {
          owner: "deco-sites",
          name: "baggagio-tanstack",
        },
      },
      [],
    );
    expect(repo?.owner).toBe("deco-sites");
    expect(repo?.connectionId).toBeUndefined();
  });

  test("returns null when connectionId is stale", () => {
    const repo = parseGithubRepoFromMetadata(
      {
        githubRepo: {
          owner: "deco-sites",
          name: "baggagio-tanstack",
          connectionId: "conn_github",
        },
      },
      ["conn_other"],
    );
    expect(repo).toBeNull();
  });

  test("returns repo when connectionId is attached", () => {
    const repo = parseGithubRepoFromMetadata(
      {
        githubRepo: {
          owner: "deco-sites",
          name: "baggagio-tanstack",
          connectionId: "conn_github",
        },
      },
      ["conn_github"],
    );
    expect(repo?.connectionId).toBe("conn_github");
  });
});

describe("GitPushAuthError", () => {
  test("is instanceof Error", () => {
    const err = new GitPushAuthError("nope");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("GitPushAuthError");
  });
});

describe("refreshSandboxGitCredentials", () => {
  test("decodes buildCloneInfo's SANDBOX_START_ERROR_CODES prefix into a clean GitPushAuthError", async () => {
    const ctx = {
      organization: { id: "org_1" },
      storage: { connections: { findById: async () => null } },
      db: {},
      vault: {},
    } as unknown as StudioContext;
    const runner = {} as SandboxProvider;

    await expect(
      refreshSandboxGitCredentials(ctx, runner, "handle_1", {
        url: "https://github.com/acme/site",
        owner: "acme",
        name: "site",
        connectionId: "conn_1",
      }),
    ).rejects.toThrow(
      new GitPushAuthError(
        "GitHub connection conn_1 no longer exists. Link acme/site again.",
      ),
    );
  });
});
