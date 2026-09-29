/**
 * Real-Postgres coverage for `resolveSandboxGitRef`: the repository row a
 * thread, or else its agent, is bound to decides whether the ref it returns is
 * the flat one — the same repository `SANDBOX_START` clones.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { getSettings, setGlobalSettings } from "@/settings";
import { resolveConfig } from "@/settings/resolve-config";
import type { Settings } from "@/settings/types";
import { RepositoryStorage } from "@/storage/repositories";
import type { GithubRepo, VirtualMCPCreateData } from "@decocms/shared/sdk";
import {
  buildThreadTestContext,
  type ThreadTestEnv,
} from "../thread/test-helpers";
import {
  flatSandboxRef,
  resolveSandboxGitRef,
  threadBranch,
} from "./thread-repo";

/** A complete Settings, as `enqueue-task-run.test.ts` builds one. */
function settingsWith(env: Record<string, string>): Settings {
  const { settings } = resolveConfig(
    { port: "", home: "", localMode: false, skipMigrations: false },
    env,
  );
  return { ...settings, databaseUrl: "", natsUrls: [] } as Settings;
}

const previousSettings = (() => {
  try {
    return getSettings();
  } catch {
    return null;
  }
})();

const OTHER_ORG = "org_456";

describe("resolveSandboxGitRef", () => {
  let env: ThreadTestEnv;
  let ctx: StudioContext;
  let gitlabRepo: GithubRepo;
  let githubRepo: GithubRepo;
  let gitlabAgentId: string;
  let foreignAgentId: string;
  let plainAgentId: string;

  beforeAll(async () => {
    env = await buildThreadTestContext();
    const repositories = new RepositoryStorage(env.database.db);
    ctx = {
      ...env.ctx,
      storage: { ...env.ctx.storage, repositories },
    } as StudioContext;

    // A self-hosted host: nothing in the name says GitLab, only the row does.
    const gitlab = await repositories.upsert({
      organizationId: env.orgId,
      ref: { provider: "gitlab", host: "git.example.net", path: "stores/shop" },
    });
    const github = await repositories.upsert({
      organizationId: env.orgId,
      ref: { provider: "github", host: "github.com", path: "acme/site" },
    });
    gitlabRepo = {
      owner: "stores",
      name: "shop",
      url: "https://git.example.net/stores/shop",
      repositoryId: gitlab.id,
    };
    githubRepo = {
      owner: "acme",
      name: "site",
      url: "https://github.com/acme/site",
      repositoryId: github.id,
    };

    await ctx.storage.threads.create({
      id: "thrd_gitlab",
      title: "gitlab",
      created_by: env.userId,
      metadata: { githubRepo: gitlabRepo },
    });
    await ctx.storage.threads.create({
      id: "thrd_github",
      title: "github",
      created_by: env.userId,
      metadata: { githubRepo: githubRepo },
    });
    await ctx.storage.threads.create({
      id: "thrd_unbound",
      title: "unbound",
      created_by: env.userId,
    });

    const agent = (orgId: string, metadata: VirtualMCPCreateData["metadata"]) =>
      ctx.storage.virtualMcps.create(orgId, env.userId, {
        title: "agent",
        status: "active",
        pinned: false,
        connections: [],
        metadata,
      });
    gitlabAgentId = (await agent(env.orgId, { githubRepo: gitlabRepo })).id;
    foreignAgentId = (await agent(OTHER_ORG, { githubRepo: gitlabRepo })).id;
    plainAgentId = (await agent(env.orgId, null)).id;
  });

  afterAll(async () => {
    if (previousSettings) setGlobalSettings(previousSettings);
    await env.close();
  });

  describe("with SANDBOX_FLAT_GITLAB_REFS on", () => {
    beforeAll(() => {
      setGlobalSettings(settingsWith({ SANDBOX_FLAT_GITLAB_REFS: "true" }));
    });

    test("only GitLab gets the flat ref", () => {
      expect(flatSandboxRef("gitlab")).toBe(true);
      expect(flatSandboxRef("github")).toBe(false);
      expect(flatSandboxRef("bitbucket")).toBe(false);
      expect(flatSandboxRef(null)).toBe(false);
    });

    test("a thread bound to a GitLab repository gets the flat ref", async () => {
      expect(
        await resolveSandboxGitRef(ctx, {
          branch: threadBranch("thrd_gitlab", "conn_a"),
          virtualMcpId: plainAgentId,
        }),
      ).toBe("sandbox-thread-thrd_gitlab-conn_a");
    });

    test("a thread bound to a GitHub repository keeps the slash", async () => {
      expect(
        await resolveSandboxGitRef(ctx, {
          branch: threadBranch("thrd_github"),
          virtualMcpId: gitlabAgentId,
        }),
      ).toBe("sandbox/thread-thrd_github");
    });

    test("an unbound thread falls back to its agent's repository", async () => {
      expect(
        await resolveSandboxGitRef(ctx, {
          branch: threadBranch("thrd_unbound"),
          virtualMcpId: gitlabAgentId,
        }),
      ).toBe("sandbox-thread-thrd_unbound");
    });

    test("an agent from another organization is not consulted", async () => {
      expect(
        await resolveSandboxGitRef(ctx, {
          branch: threadBranch("thrd_unbound"),
          virtualMcpId: foreignAgentId,
        }),
      ).toBe("sandbox/thread-thrd_unbound");
    });

    test("no repository anywhere keeps the slash", async () => {
      expect(
        await resolveSandboxGitRef(ctx, {
          branch: threadBranch("thrd_unbound"),
          virtualMcpId: plainAgentId,
        }),
      ).toBe("sandbox/thread-thrd_unbound");
    });
  });

  describe("with SANDBOX_FLAT_GITLAB_REFS off", () => {
    beforeAll(() => {
      setGlobalSettings(settingsWith({}));
    });

    test("GitLab keeps the slash", async () => {
      expect(flatSandboxRef("gitlab")).toBe(false);
      expect(
        await resolveSandboxGitRef(ctx, {
          branch: threadBranch("thrd_gitlab"),
          virtualMcpId: gitlabAgentId,
        }),
      ).toBe("sandbox/thread-thrd_gitlab");
    });
  });
});
