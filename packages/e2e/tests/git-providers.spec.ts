/**
 * End-to-end tests for first-class repositories and git provider accounts
 * (GIT_PROVIDER_CAPABILITIES, GIT_ACCOUNT_*, REPOSITORY_* tools).
 *
 * The wire contract under test: a repository is an org-scoped entity keyed by
 * (host, path) case-insensitively, its provider is derived from the URL, and
 * every read/write is scoped to the caller's org. Linking without an account
 * is the anonymous public-clone case and touches no provider, so this suite
 * stays hermetic while still covering the whole HTTP + DB path.
 *
 * OUT OF SCOPE: anything that needs a live provider — linking WITH an account
 * (verified against GitHub/GitLab before the row is written), searching a
 * provider's repositories, and minting a clone credential. Those need a real
 * GitHub App installation or a GitLab token, the same boundary
 * github-import-repo-scope.spec.ts and org-repo-sync.spec.ts draw. The
 * provider clients themselves are exercised against the live REST APIs
 * out-of-band, and their pure parts are unit-tested next to the source.
 */

import type { APIRequestContext } from "@playwright/test";
import type { Client } from "pg";
import { signUpViaApi } from "../fixtures/auth-api";
import { connectDevDb } from "../fixtures/db";
import { callSelfMcpTool, findOrgId } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

interface Repository {
  id: string;
  organizationId: string;
  accountId: string | null;
  provider: "github" | "gitlab";
  host: string;
  path: string;
  externalId: string | null;
  defaultBranch: string | null;
  webUrl: string;
  visibility: "public" | "private" | "internal" | null;
}

function linkRepository(
  ctx: APIRequestContext,
  org: string,
  url: string,
): Promise<{ repository: Repository }> {
  return callSelfMcpTool<{ repository: Repository }>(
    ctx,
    org,
    "REPOSITORY_LINK",
    { url },
  );
}

function listRepositories(
  ctx: APIRequestContext,
  org: string,
): Promise<{ repositories: Repository[] }> {
  return callSelfMcpTool<{ repositories: Repository[] }>(
    ctx,
    org,
    "REPOSITORY_LIST",
    {},
  );
}

/** A unique repo path per test, so `fullyParallel` runs cannot collide. */
function uniquePath(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

test.describe("Git providers: repositories as an org entity", () => {
  test("links a GitHub URL, deriving provider, host and web URL", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);
    const path = `acme/${uniquePath("site")}`;

    const { repository } = await linkRepository(
      ctx,
      orgSlug,
      `https://github.com/${path}`,
    );

    expect(repository.provider).toBe("github");
    expect(repository.host).toBe("github.com");
    expect(repository.path).toBe(path);
    expect(repository.webUrl).toBe(`https://github.com/${path}`);
    // No account: an anonymous public clone, with no provider facts recorded.
    expect(repository.accountId).toBeNull();
    expect(repository.externalId).toBeNull();
    expect(repository.defaultBranch).toBeNull();
  });

  /**
   * The reason repositories exist as rows at all: a GitLab project can live at
   * any namespace depth, which the `owner`/`name` pair this replaces could not
   * represent. A browser URL's `/-/` sub-resource is not part of the path.
   */
  test("links a GitLab project nested in subgroups, from a merge-request URL", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);
    const path = `group/subgroup/${uniquePath("project")}`;

    const { repository } = await linkRepository(
      ctx,
      orgSlug,
      `https://gitlab.com/${path}/-/merge_requests/7`,
    );

    expect(repository.provider).toBe("gitlab");
    expect(repository.host).toBe("gitlab.com");
    expect(repository.path).toBe(path);
    expect(repository.webUrl).toBe(`https://gitlab.com/${path}`);
  });

  test("accepts an ssh URL and strips the .git suffix", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);
    const path = `acme/${uniquePath("ssh")}`;

    const { repository } = await linkRepository(
      ctx,
      orgSlug,
      `git@github.com:${path}.git`,
    );

    expect(repository.path).toBe(path);
    expect(repository.provider).toBe("github");
  });

  test("re-linking the same repository in different casing updates one row", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);
    const path = `Acme/${uniquePath("Case")}`;

    const first = await linkRepository(
      ctx,
      orgSlug,
      `https://github.com/${path}`,
    );
    const second = await linkRepository(
      ctx,
      orgSlug,
      `https://github.com/${path.toLowerCase()}`,
    );

    expect(second.repository.id).toBe(first.repository.id);
    const { repositories } = await listRepositories(ctx, orgSlug);
    expect(
      repositories.filter((r) => r.path.toLowerCase() === path.toLowerCase()),
    ).toHaveLength(1);
  });

  test("rejects a URL whose provider cannot be determined", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);

    for (const url of [
      "https://git.example.com/acme/site",
      "https://github.com/acme",
      "acme/site",
      "not a url",
    ]) {
      await expect(linkRepository(ctx, orgSlug, url)).rejects.toThrow(
        /recognise the repository URL/i,
      );
    }
  });

  test("lists and deletes repositories, scoped to the org", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);
    const path = `acme/${uniquePath("lifecycle")}`;

    const { repository } = await linkRepository(
      ctx,
      orgSlug,
      `https://github.com/${path}`,
    );

    const listed = await listRepositories(ctx, orgSlug);
    expect(listed.repositories.map((r) => r.id)).toContain(repository.id);

    const deleted = await callSelfMcpTool<{ deleted: boolean }>(
      ctx,
      orgSlug,
      "REPOSITORY_DELETE",
      { id: repository.id },
    );
    expect(deleted.deleted).toBe(true);

    const after = await listRepositories(ctx, orgSlug);
    expect(after.repositories.map((r) => r.id)).not.toContain(repository.id);

    // Deleting something already gone is a no-op, not an error.
    const again = await callSelfMcpTool<{ deleted: boolean }>(
      ctx,
      orgSlug,
      "REPOSITORY_DELETE",
      { id: repository.id },
    );
    expect(again.deleted).toBe(false);
  });

  test("a fresh org has no accounts and no repositories", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);

    const { repositories } = await listRepositories(ctx, orgSlug);
    expect(repositories).toEqual([]);
    const { accounts } = await callSelfMcpTool<{ accounts: unknown[] }>(
      ctx,
      orgSlug,
      "GIT_ACCOUNT_LIST",
      {},
    );
    expect(accounts).toEqual([]);
  });

  /**
   * The feature is dormant until an operator registers the provider apps: with
   * no credentials configured the connect paths are absent rather than broken
   * links, and nothing in the legacy `mcp-github` flow depends on them.
   */
  test("capabilities report what this deployment can connect", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);

    const caps = await callSelfMcpTool<{
      github: {
        configured: boolean;
        connectPath: string | null;
        installPath: string | null;
      };
      gitlab: { oauthHosts: string[]; connectPath: string | null };
    }>(ctx, orgSlug, "GIT_PROVIDER_CAPABILITIES", {});

    if (caps.github.configured) {
      expect(caps.github.connectPath).toBe(
        `/api/${orgSlug}/git-providers/github/connect`,
      );
      expect(caps.github.installPath).toBe(
        `/api/${orgSlug}/git-providers/github/install`,
      );
    } else {
      expect(caps.github.connectPath).toBeNull();
      expect(caps.github.installPath).toBeNull();
    }
    if (caps.gitlab.oauthHosts.length === 0) {
      expect(caps.gitlab.connectPath).toBeNull();
    } else {
      expect(caps.gitlab.connectPath).toBe(
        `/api/${orgSlug}/git-providers/gitlab/connect`,
      );
    }
  });

  /** The token is validated against the provider before anything is stored. */
  test("a GitLab account cannot be connected with a token the provider rejects", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);

    await expect(
      callSelfMcpTool(ctx, orgSlug, "GIT_ACCOUNT_CONNECT_TOKEN", {
        type: "gitlab",
        host: "gitlab.com",
        token: `not-a-real-gitlab-token-${Date.now()}`,
      }),
    ).rejects.toThrow();

    const { accounts } = await callSelfMcpTool<{ accounts: unknown[] }>(
      ctx,
      orgSlug,
      "GIT_ACCOUNT_LIST",
      {},
    );
    expect(accounts).toEqual([]);
  });

  test("GitHub accounts refuse a token: they go through the App", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);

    await expect(
      callSelfMcpTool(ctx, orgSlug, "GIT_ACCOUNT_CONNECT_TOKEN", {
        type: "github",
        host: "github.com",
        token: "not-a-real-github-token",
      }),
    ).rejects.toThrow(/GitHub App/i);
  });

  test("rejects a host that is not a bare hostname", async ({ playwright }) => {
    const ctx = await newApiContext(playwright);
    const { orgSlug } = await signUpViaApi(ctx);

    await expect(
      callSelfMcpTool(ctx, orgSlug, "GIT_ACCOUNT_CONNECT_TOKEN", {
        type: "gitlab",
        host: "https://gitlab.acme.com/api",
        token: "not-a-real-token",
      }),
    ).rejects.toThrow(/bare hostname/i);
  });
});

test.describe("Git providers: tenancy", () => {
  let db: Client;

  test.beforeAll(async () => {
    db = await connectDevDb();
  });

  test.afterAll(async () => {
    await db.end();
  });

  /**
   * Two orgs may link the same repository; each owns its own row, and neither
   * can see or delete the other's. The attacker's session gets an explicit
   * set-active: a signup-only session has `activeOrganizationId` NULL, which
   * leaves `role` undefined and would let a broken gate pass unnoticed.
   */
  test("one org cannot read or delete another org's repository", async ({
    playwright,
  }) => {
    const victimCtx = await newApiContext(playwright);
    const victim = await signUpViaApi(victimCtx);
    const attackerCtx = await newApiContext(playwright);
    const attacker = await signUpViaApi(attackerCtx);

    const shared = `acme/${uniquePath("shared")}`;
    const victimRepo = (
      await linkRepository(
        victimCtx,
        victim.orgSlug,
        `https://github.com/${shared}`,
      )
    ).repository;
    const attackerRepo = (
      await linkRepository(
        attackerCtx,
        attacker.orgSlug,
        `https://github.com/${shared}`,
      )
    ).repository;

    // Same path, two tenants, two rows.
    expect(attackerRepo.id).not.toBe(victimRepo.id);

    const attackerOrgId = await findOrgId(attackerCtx, attacker.orgSlug);
    const setActive = await attackerCtx.post(
      "/api/auth/organization/set-active",
      { data: { organizationId: attackerOrgId } },
    );
    expect(setActive.ok()).toBe(true);

    const attackerList = await listRepositories(attackerCtx, attacker.orgSlug);
    expect(attackerList.repositories.map((r) => r.id)).toEqual([
      attackerRepo.id,
    ]);

    const crossDelete = await callSelfMcpTool<{ deleted: boolean }>(
      attackerCtx,
      attacker.orgSlug,
      "REPOSITORY_DELETE",
      { id: victimRepo.id },
    );
    expect(crossDelete.deleted).toBe(false);

    // Asserted on the row itself, not just on the tool's answer.
    const { rows } = await db.query<{ organization_id: string }>(
      "select organization_id from repositories where id = $1",
      [victimRepo.id],
    );
    expect(rows).toHaveLength(1);
    const victimOrgId = await findOrgId(victimCtx, victim.orgSlug);
    expect(rows[0]?.organization_id).toBe(victimOrgId);
  });
});
