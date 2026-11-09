import { describe, expect, mock, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import {
  encodeSandboxStartError,
  SANDBOX_START_ERROR_CODES,
} from "@decocms/shared/sandbox-start-errors";
import type { StudioContext } from "../../core/studio-context";

const buildCloneInfo = mock(
  async (..._args: unknown[]): Promise<Record<string, string>> => {
    throw new Error(
      encodeSandboxStartError(
        SANDBOX_START_ERROR_CODES.githubConnectionMissing,
        "GitHub connection conn_1 no longer exists. Link acme/site again.",
      ),
    );
  },
);
const ensureGithubCloneToken = mock(async (_params: unknown) => {});

mock.module("../../shared/github-clone-info", () => ({
  buildCloneInfo,
  ensureGithubCloneToken,
}));

const {
  GitPushAuthError,
  parseRepositoryBinding,
  refreshSandboxGitCredentials,
  rotateGitCredentialWhileRunning,
  rotateReusedSandboxGitCredential,
} = await import("./sync-git-credentials");

const legacyRepoCtx = {
  organization: { id: "org_1" },
  storage: {
    connections: { findById: async () => null },
    // No repository row: these tests cover the legacy `mcp-github` path.
    repositories: { get: async () => null, findByRef: async () => null },
    gitProviderAccounts: { getUnscoped: async () => null },
  },
  db: {},
  vault: {},
} as unknown as StudioContext;

const legacyRepo = {
  url: "https://github.com/acme/site",
  owner: "acme",
  name: "site",
  connectionId: "conn_1",
};

describe("parseRepositoryBinding", () => {
  test("returns public-clone repo without connectionId", () => {
    const repo = parseRepositoryBinding(
      {
        repository: {
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
    const repo = parseRepositoryBinding(
      {
        repository: {
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
    const repo = parseRepositoryBinding(
      {
        repository: {
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
    const runner = {} as Parameters<typeof refreshSandboxGitCredentials>[1];

    await expect(
      refreshSandboxGitCredentials(
        legacyRepoCtx,
        runner,
        "handle_1",
        legacyRepo,
      ),
    ).rejects.toThrow(
      new GitPushAuthError(
        "GitHub connection conn_1 no longer exists. Link acme/site again.",
      ),
    );
  });
});

describe("rotateReusedSandboxGitCredential", () => {
  test("puts only the clone URL, minted without forcing a fresh token", async () => {
    const cloneUrl = "https://x-access-token:fresh@github.com/acme/site.git";
    buildCloneInfo.mockImplementationOnce(async () => ({
      cloneUrl,
      gitUserName: "someone",
      gitUserEmail: "someone@example.com",
    }));
    ensureGithubCloneToken.mockClear();
    const requests: { path: string; init: RequestInit }[] = [];
    const runner = {
      proxyDaemonRequest: async (
        _handle: string,
        path: string,
        init: RequestInit,
      ) => {
        requests.push({ path, init });
        return new Response("{}");
      },
    } as unknown as Parameters<typeof rotateReusedSandboxGitCredential>[1];

    await rotateReusedSandboxGitCredential(
      legacyRepoCtx,
      runner,
      "handle_1",
      legacyRepo,
    );

    expect(ensureGithubCloneToken.mock.calls[0]?.[0]).toMatchObject({
      forceRefresh: false,
    });
    expect(buildCloneInfo.mock.calls.at(-1)?.[5]).toEqual({
      bufferMs: 30 * 60_000,
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.path).toBe("/_sandbox/config");
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      git: { repository: { cloneUrl } },
    });
  });

  test("surfaces a rejected config request", async () => {
    buildCloneInfo.mockImplementationOnce(async () => ({
      cloneUrl: "https://x-access-token:fresh@github.com/acme/site.git",
      gitUserName: "someone",
      gitUserEmail: "someone@example.com",
    }));
    const runner = {
      proxyDaemonRequest: async () => new Response("gone", { status: 410 }),
    } as unknown as Parameters<typeof rotateReusedSandboxGitCredential>[1];

    await expect(
      rotateReusedSandboxGitCredential(
        legacyRepoCtx,
        runner,
        "handle_1",
        legacyRepo,
      ),
    ).rejects.toThrow("(410)");
  });
});

describe("rotateGitCredentialWhileRunning", () => {
  test("keeps rotating until stopped, and survives a failed rotation", async () => {
    buildCloneInfo.mockImplementation(async () => ({
      cloneUrl: "https://x-access-token:fresh@github.com/acme/site.git",
      gitUserName: "someone",
      gitUserEmail: "someone@example.com",
    }));
    let puts = 0;
    const runner = {
      proxyDaemonRequest: async () =>
        ++puts === 1
          ? new Response("busy", { status: 503 })
          : new Response("{}"),
    } as unknown as Parameters<typeof rotateGitCredentialWhileRunning>[1];

    const stop = rotateGitCredentialWhileRunning(
      legacyRepoCtx,
      runner,
      "handle_1",
      legacyRepo,
      5,
    );
    await sleep(40);
    stop();
    const atStop = puts;
    await sleep(30);

    expect(atStop).toBeGreaterThanOrEqual(2);
    expect(puts).toBe(atStop);
    buildCloneInfo.mockReset();
  });
});
