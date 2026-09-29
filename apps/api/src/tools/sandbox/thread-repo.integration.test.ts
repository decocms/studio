/**
 * Real-Postgres coverage for `sandboxGitRef`: a public host's URL names the
 * provider on its own, and only a self-hosted one is looked up — by primary
 * key, inside the caller's organization.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { RepositoryStorage } from "@/storage/repositories";
import type { RepositoryBinding } from "@decocms/shared/sdk";
import {
  buildThreadTestContext,
  type ThreadTestEnv,
} from "../thread/test-helpers";
import { flatSandboxRef, sandboxGitRef, threadBranch } from "./thread-repo";

const BRANCH = threadBranch("thrd_1", "conn_a");
const FLAT = "sandbox-thread-thrd_1-conn_a";
const SLASH = "sandbox/thread-thrd_1-conn_a";

describe("sandboxGitRef", () => {
  let env: ThreadTestEnv;
  let ctx: StudioContext;
  let selfHostedGitlab: RepositoryBinding;
  let selfHostedGithub: RepositoryBinding;
  let foreignGitlab: RepositoryBinding;

  beforeAll(async () => {
    env = await buildThreadTestContext();
    const repositories = new RepositoryStorage(env.database.db);
    ctx = {
      ...env.ctx,
      storage: { ...env.ctx.storage, repositories },
    } as StudioContext;

    // Nothing in these host names says which provider serves them.
    const gitlab = await repositories.upsert({
      organizationId: env.orgId,
      ref: { provider: "gitlab", host: "git.example.net", path: "stores/shop" },
    });
    const github = await repositories.upsert({
      organizationId: env.orgId,
      ref: { provider: "github", host: "code.example.net", path: "acme/site" },
    });
    const foreign = await repositories.upsert({
      organizationId: "org_456",
      ref: { provider: "gitlab", host: "git.example.net", path: "other/shop" },
    });
    selfHostedGitlab = {
      owner: "stores",
      name: "shop",
      url: "https://git.example.net/stores/shop",
      repositoryId: gitlab.id,
    };
    selfHostedGithub = {
      owner: "acme",
      name: "site",
      url: "https://code.example.net/acme/site",
      repositoryId: github.id,
    };
    foreignGitlab = {
      owner: "other",
      name: "shop",
      url: "https://git.example.net/other/shop",
      repositoryId: foreign.id,
    };
  });

  afterAll(async () => {
    await env.close();
  });

  test("only GitLab gets the flat ref", () => {
    expect(flatSandboxRef("gitlab")).toBe(true);
    expect(flatSandboxRef("github")).toBe(false);
    expect(flatSandboxRef("bitbucket")).toBe(false);
    expect(flatSandboxRef(null)).toBe(false);
  });

  test("a public host's URL decides without a repository row", async () => {
    const gitlabCom = {
      owner: "group",
      name: "project",
      url: "https://gitlab.com/group/project",
    };
    const githubCom = {
      owner: "acme",
      name: "site",
      url: "https://github.com/acme/site",
    };
    expect(await sandboxGitRef(ctx, BRANCH, gitlabCom)).toBe(FLAT);
    expect(await sandboxGitRef(ctx, BRANCH, githubCom)).toBe(SLASH);
  });

  test("a self-hosted host is decided by its repository row", async () => {
    expect(await sandboxGitRef(ctx, BRANCH, selfHostedGitlab)).toBe(FLAT);
    expect(await sandboxGitRef(ctx, BRANCH, selfHostedGithub)).toBe(SLASH);
  });

  test("a binding stored without a URL still resolves by its row", async () => {
    const { url: _url, ...withoutUrl } = selfHostedGitlab;
    expect(
      await sandboxGitRef(ctx, BRANCH, withoutUrl as RepositoryBinding),
    ).toBe(FLAT);
  });

  test("another organization's repository row is not read", async () => {
    expect(await sandboxGitRef(ctx, BRANCH, foreignGitlab)).toBe(SLASH);
  });

  test("no row and an unknown host, or no binding, keep the slash", async () => {
    const unknown = {
      owner: "stores",
      name: "shop",
      url: "https://git.example.net/stores/shop",
    };
    expect(await sandboxGitRef(ctx, BRANCH, unknown)).toBe(SLASH);
    expect(await sandboxGitRef(ctx, BRANCH, null)).toBe(SLASH);
  });
});
