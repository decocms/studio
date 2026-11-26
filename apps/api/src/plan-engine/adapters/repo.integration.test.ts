/**
 * Which repository a run may read, against real Postgres: only one the run's
 * organization linked, and why not otherwise. Every case stops before a
 * provider call, so no provider is stood in.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import type { StudioDatabase } from "../../database";
import {
  closeTestPgDatabase,
  connectTestPgDatabase,
  resetTestPgDatabase,
} from "../../database/test-db-pg";
import { CredentialVault } from "../../encryption/credential-vault";
import { GitProviderAccountStorage } from "../../storage/git-provider-accounts";
import { RepositoryStorage } from "../../storage/repositories";
import type { SiteProfile, SiteSources } from "../types.ts";
import { CODE_UNAVAILABLE, CodeGapError } from "../verify/code-source.ts";
import { codeAccessFor } from "./repo.ts";

const ORG = "org_plan_repo_a";
const OTHER = "org_plan_repo_b";

type Profile = Pick<SiteProfile, "code_repo" | "sources">;

const sources = (repository: SiteSources["repository"]): SiteSources => ({
  detected_at: "2026-11-20T00:00:00.000Z",
  studio_project: null,
  repository,
  errors: [],
});

describe("codeAccessFor", () => {
  let database: StudioDatabase;
  let repositories: RepositoryStorage;
  let accounts: GitProviderAccountStorage;
  let ctx: StudioContext;
  let otherRepoId = "";

  /** Opens the access and returns the gap it was refused with. */
  async function refusal(profile: Profile) {
    const access = codeAccessFor(ctx, ORG, profile);
    if (access.kind !== "ready") throw new Error("expected a ready access");
    const err = await access.open().catch((e: unknown) => e);
    if (!(err instanceof CodeGapError)) throw err;
    return err.gap;
  }

  beforeAll(async () => {
    database = await connectTestPgDatabase();
    await resetTestPgDatabase(database);
    const now = new Date().toISOString();
    for (const id of [ORG, OTHER]) {
      await database.db
        .insertInto("organization")
        .values({ id, name: id, slug: id, createdAt: now })
        .execute();
    }
    repositories = new RepositoryStorage(database.db);
    accounts = new GitProviderAccountStorage(database.db);
    ctx = {
      db: database.db,
      vault: new CredentialVault(CredentialVault.generateKey()),
      storage: { repositories, gitProviderAccounts: accounts },
    } as unknown as StudioContext;

    otherRepoId = (
      await repositories.upsert({
        organizationId: OTHER,
        ref: { provider: "github", host: "github.com", path: "acme/outra" },
      })
    ).id;
    // Linked in this org, but anonymously: no account to read it with.
    await repositories.upsert({
      organizationId: ORG,
      ref: {
        provider: "github",
        host: "github.com",
        path: "acme/loja-exemplo",
      },
    });
    const revoked = await accounts.upsert({
      organizationId: ORG,
      type: "gitlab",
      host: "gitlab.com",
      authKind: "token",
      externalAccountId: "gl_1",
      login: "grupo",
    });
    await accounts.setStatus(revoked.id, ORG, "revoked");
    await repositories.upsert({
      organizationId: ORG,
      accountId: revoked.id,
      ref: {
        provider: "gitlab",
        host: "gitlab.com",
        path: "grupo/loja-exemplo",
      },
    });
    // Same host and path as a GitLab URL would name, stored as another provider.
    await repositories.upsert({
      organizationId: ORG,
      ref: {
        provider: "github",
        host: "git.empresa.example",
        path: "grupo/loja",
      },
    });
  });

  afterAll(async () => {
    await closeTestPgDatabase(database);
  });

  it("no repository on the site project: the customer links one, nothing read", () => {
    const access = codeAccessFor(ctx, ORG, {
      code_repo: null,
      sources: sources(null),
    });
    expect(access).toEqual({
      kind: "gap",
      gap: {
        source: "github",
        error: `${CODE_UNAVAILABLE}: o projeto do site no Studio não tem repositório ligado`,
        owner: "customer",
        key: "repository",
      },
    });
    expect(codeAccessFor(ctx, ORG, null).kind).toBe("gap");
  });

  it("a repository the org never linked is refused, even when another org linked it", async () => {
    expect(await refusal({ code_repo: "acme/outra", sources: null })).toEqual({
      source: "github",
      error: `${CODE_UNAVAILABLE}: o repositório acme/outra não está ligado a esta org no Studio`,
      owner: "customer",
      key: "repository",
    });
  });

  it("another org's repository id on the project is not read", async () => {
    const gap = await refusal({
      code_repo: null,
      sources: sources({
        owner: "acme",
        name: "outra",
        connection_id: null,
        repository_id: otherRepoId,
      }),
    });
    expect(gap.owner).toBe("customer");
    expect(gap.error).toContain("não está ligado a esta org");
  });

  it("an identity whose provider disagrees with the stored row is not linked", async () => {
    const gap = await refusal({
      code_repo: "https://gitlab.empresa.example/grupo/loja",
      sources: null,
    });
    expect(gap.error).toContain(
      "o repositório gitlab.empresa.example/grupo/loja não está ligado",
    );
  });

  it("linked without an account: reconnect GitHub", async () => {
    const gap = await refusal({
      code_repo: null,
      sources: sources({
        owner: "Acme",
        name: "Loja-Exemplo",
        connection_id: null,
      }),
    });
    expect(gap).toEqual({
      source: "github",
      error: `${CODE_UNAVAILABLE}: a conexão do Studio com o GitHub não lê mais o repositório Acme/Loja-Exemplo: reconecte o GitHub no Studio`,
      owner: "customer",
      key: "repository",
    });
  });

  it("a revoked GitLab account: reconnect GitLab", async () => {
    const access = codeAccessFor(ctx, ORG, {
      code_repo: "https://gitlab.com/grupo/loja-exemplo.git",
      sources: null,
    });
    expect(access).toMatchObject({
      kind: "ready",
      repo: "gitlab.com/grupo/loja-exemplo",
      provider: "gitlab",
    });
    const gap = await refusal({
      code_repo: "https://gitlab.com/grupo/loja-exemplo.git",
      sources: null,
    });
    expect(gap.owner).toBe("customer");
    expect(gap.key).toBe("repository");
    expect(gap.error).toContain("reconecte o GitLab no Studio");
  });
});
