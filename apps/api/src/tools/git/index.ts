/**
 * GIT_ACCOUNT_* / REPOSITORY_* — first-class git provider accounts and
 * repositories (migration 199). App-only: the web's repo picker and settings
 * call these; models never see them.
 *
 * Provider calls go straight to the provider REST API through the client the
 * account's `type` selects. Connecting an account via OAuth is a browser
 * redirect flow (see `api/routes/git-providers.ts`); tokens are accepted here.
 */

import { z } from "zod";
import {
  GitProviderAccountSchema,
  GitProviderKindSchema,
  parseRepoUrl,
  RepositorySchema,
  RepoRefSchema,
} from "@decocms/shared/git-providers";
import { defineTool } from "@/core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "@/core/studio-context";
import {
  accountIsServable,
  clientForAccount,
  principalForToken,
  providerCapabilities,
} from "@/git-providers";
import type { GitProviderAccountRecord } from "@/storage/git-provider-accounts";
import type { RepositoryRecord } from "@/storage/repositories";

const RepoSummarySchema = z.object({
  ref: RepoRefSchema,
  externalId: z.string(),
  defaultBranch: z.string().nullable(),
  webUrl: z.string(),
  visibility: z.enum(["public", "private", "internal"]),
  description: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const AccountOutputSchema = GitProviderAccountSchema.extend({
  /** False for a backfilled GitHub account this deployment cannot mint for yet. */
  servable: z.boolean(),
});

function toAccountOutput(
  account: GitProviderAccountRecord,
): z.infer<typeof AccountOutputSchema> {
  const { credentialConnectionId: _bridge, ...entity } = account;
  return { ...entity, servable: accountIsServable(account) };
}

function toRepositoryOutput(
  repo: RepositoryRecord,
): z.infer<typeof RepositorySchema> {
  const { legacyConnectionId: _bridge, ...entity } = repo;
  return entity;
}

async function requireAccount(
  ctx: StudioContext,
  organizationId: string,
  accountId: string,
): Promise<GitProviderAccountRecord> {
  const account = await ctx.storage.gitProviderAccounts.get(
    accountId,
    organizationId,
  );
  if (!account) throw new Error("Git account not found");
  return account;
}

export const GIT_PROVIDER_CAPABILITIES = defineTool({
  name: "GIT_PROVIDER_CAPABILITIES",
  description:
    "Which git providers this deployment can connect through Studio-owned credentials, and the URLs that start each connect flow.",
  annotations: {
    title: "Git provider capabilities",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({}),
  outputSchema: z.object({
    github: z.object({
      configured: z.boolean(),
      /** Org-scoped path that starts the OAuth proof + installation sync. */
      connectPath: z.string().nullable(),
      /** Org-scoped path that sends the user to install the App on a new account. */
      installPath: z.string().nullable(),
    }),
    gitlab: z.object({
      /** Hosts with an OAuth application configured; other hosts use a token. */
      oauthHosts: z.array(z.string()),
      connectPath: z.string().nullable(),
    }),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    const base = `/api/${organization.slug ?? organization.id}/git-providers`;
    const capabilities = providerCapabilities();
    const github = capabilities.github.configured;
    return {
      github: {
        configured: github,
        connectPath: github ? `${base}/github/connect` : null,
        installPath: github ? `${base}/github/install` : null,
      },
      gitlab: {
        oauthHosts: capabilities.gitlab.hosts,
        connectPath: capabilities.gitlab.configured
          ? `${base}/gitlab/connect`
          : null,
      },
    };
  },
});

export const GIT_ACCOUNT_LIST = defineTool({
  name: "GIT_ACCOUNT_LIST",
  description: "List the git provider accounts connected to this organization.",
  annotations: {
    title: "List git accounts",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({}),
  outputSchema: z.object({ accounts: z.array(AccountOutputSchema) }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const accounts = await ctx.storage.gitProviderAccounts.listByOrg(
      organization.id,
    );
    return { accounts: accounts.map(toAccountOutput) };
  },
});

export const GIT_ACCOUNT_CONNECT_TOKEN = defineTool({
  name: "GIT_ACCOUNT_CONNECT_TOKEN",
  description:
    "Connect a git provider account with a personal, project or group access token. Validates the token against the provider before storing it encrypted. Use this for self-managed GitLab instances (no OAuth application) or when OAuth is not wanted.",
  annotations: {
    title: "Connect git account with a token",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    type: GitProviderKindSchema.describe(
      "Provider; only gitlab accepts tokens today",
    ),
    host: z
      .string()
      .min(1)
      .describe("Provider host, e.g. gitlab.com or gitlab.acme.com"),
    token: z.string().min(1).describe("Access token with api scope"),
  }),
  outputSchema: z.object({ account: AccountOutputSchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const host = input.host.trim().toLowerCase();
    if (!/^[a-z0-9.-]+(:[0-9]+)?$/.test(host)) {
      throw new Error("host must be a bare hostname, optionally with a port");
    }
    // Refuses GitHub by policy — see `principalForToken`.
    const principal = await principalForToken(input.type, host, input.token);
    const account = await ctx.storage.gitProviderAccounts.upsert({
      organizationId: organization.id,
      type: input.type,
      host,
      authKind: "token",
      externalAccountId: principal.externalAccountId,
      login: principal.login,
      avatarUrl: principal.avatarUrl,
      createdBy: getUserId(ctx) ?? null,
    });
    await ctx.storage.gitProviderAccountCredentials.upsert({
      connectionId: account.id,
      accessToken: input.token,
      refreshToken: null,
      scope: null,
      expiresAt: null,
      clientId: null,
      clientSecret: null,
      tokenEndpoint: null,
    });
    return { account: toAccountOutput(account) };
  },
});

export const GIT_ACCOUNT_DELETE = defineTool({
  name: "GIT_ACCOUNT_DELETE",
  description:
    "Disconnect a git provider account. Its repositories stay linked but lose credentials (they become anonymous clones) until linked to another account.",
  annotations: {
    title: "Disconnect git account",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ deleted: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const deleted = await ctx.storage.gitProviderAccounts.delete(
      input.id,
      organization.id,
    );
    return { deleted };
  },
});

export const REPOSITORY_LIST = defineTool({
  name: "REPOSITORY_LIST",
  description: "List the repositories linked to this organization.",
  annotations: {
    title: "List repositories",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    accountId: z
      .string()
      .optional()
      .describe("Only repositories of this account"),
  }),
  outputSchema: z.object({ repositories: z.array(RepositorySchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const repositories = await ctx.storage.repositories.listByOrg(
      organization.id,
      { accountId: input.accountId },
    );
    return { repositories: repositories.map(toRepositoryOutput) };
  },
});

export const REPOSITORY_SEARCH = defineTool({
  name: "REPOSITORY_SEARCH",
  description:
    "Search the repositories an account can reach on its provider (not yet linked). Feeds the repository picker.",
  annotations: {
    title: "Search provider repositories",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    accountId: z.string(),
    query: z.string().optional(),
    page: z.number().int().min(1).optional(),
    perPage: z.number().int().min(1).max(100).optional(),
  }),
  outputSchema: z.object({ repositories: z.array(RepoSummarySchema) }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const account = await requireAccount(ctx, organization.id, input.accountId);
    const client = clientForAccount({ db: ctx.db, vault: ctx.vault }, account);
    const repositories = await client.listRepos({
      query: input.query,
      page: input.page,
      perPage: input.perPage,
    });
    return { repositories };
  },
});

export const REPOSITORY_LINK = defineTool({
  name: "REPOSITORY_LINK",
  description:
    "Link a repository to the organization. With an account, the repository is verified against the provider and its facts (id, default branch, visibility) recorded; without one it is linked as an anonymous public clone.",
  annotations: {
    title: "Link repository",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    url: z
      .string()
      .min(1)
      .describe(
        "Repository URL (https or ssh), or a bare path like owner/name when accountId is given",
      ),
    accountId: z
      .string()
      .optional()
      .describe("Account whose credentials access the repository"),
  }),
  outputSchema: z.object({ repository: RepositorySchema }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const userId = getUserId(ctx) ?? null;

    if (!input.accountId) {
      const ref = parseRepoUrl(input.url);
      if (!ref) {
        throw new Error(
          "Could not recognise the repository URL. Use a full https URL from GitHub or GitLab.",
        );
      }
      const repository = await ctx.storage.repositories.upsert({
        organizationId: organization.id,
        ref,
        createdBy: userId,
      });
      return { repository: toRepositoryOutput(repository) };
    }

    const account = await requireAccount(ctx, organization.id, input.accountId);
    const ref = parseRepoUrl(input.url, {
      provider: account.type,
      host: account.host,
    });
    if (!ref) throw new Error("Could not recognise the repository URL or path");
    if (ref.host !== account.host) {
      throw new Error(
        `Repository is on ${ref.host} but the account is on ${account.host}`,
      );
    }
    const client = clientForAccount({ db: ctx.db, vault: ctx.vault }, account);
    const summary = await client.getRepo(ref);
    if (!summary) {
      throw new Error(
        `${ref.path} was not found on ${ref.host} or the account cannot access it`,
      );
    }
    const repository = await ctx.storage.repositories.upsert({
      organizationId: organization.id,
      ref: summary.ref,
      accountId: account.id,
      externalId: summary.externalId,
      defaultBranch: summary.defaultBranch,
      visibility: summary.visibility,
      createdBy: userId,
    });
    return { repository: toRepositoryOutput(repository) };
  },
});

export const REPOSITORY_DELETE = defineTool({
  name: "REPOSITORY_DELETE",
  description:
    "Unlink a repository from the organization. Agents, tasks and syncs that referenced it keep working off their legacy metadata until relinked.",
  annotations: {
    title: "Unlink repository",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({ id: z.string() }),
  outputSchema: z.object({ deleted: z.boolean() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const deleted = await ctx.storage.repositories.delete(
      input.id,
      organization.id,
    );
    return { deleted };
  },
});

export { REPOSITORY_SEARCH_BRANCHES } from "./branches";
