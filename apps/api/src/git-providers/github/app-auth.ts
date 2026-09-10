/**
 * GitHub App authentication: the App JWT and the installation tokens minted
 * from it.
 *
 * One instance per configured App (there is one per deployment). Installation
 * tokens are cached in memory per (installation, repositories, permissions)
 * and re-minted once they are within `bufferMs` of expiry; concurrent callers
 * for the same key share one mint.
 *
 * GitHub App private keys are PKCS#1 PEM ("RSA PRIVATE KEY"), which `jose`
 * does not import, so the JWT is signed with `node:crypto` directly.
 */

import { createPrivateKey, sign } from "node:crypto";
import { z } from "zod";
import {
  isPermissionRejected,
  OPTIONAL_MINT_PERMISSIONS,
} from "@decocms/shared/github-repo-scope";
import { APP_BUDGET_OWNER, rememberBudgetOwner } from "./budget-owner";
import { type GithubAppConfig, readGithubAppConfig } from "./env";
import type { GitProviderCapability } from "../types";
import { GitProviderError } from "../types";
import {
  githubApiBaseUrl,
  githubErrorMessage,
  githubFailure,
  githubFailureFromBody,
  githubFetch,
  githubJson,
} from "./http";

const DEFAULT_API_BASE_URL = "https://api.github.com";

/**
 * GitHub caps App JWTs at 10 minutes and rejects an `iat` in the future, so
 * the token is backdated a minute and expires 9 minutes ahead — a 60s clock
 * skew either way still lands inside the window.
 */
const JWT_BACKDATE_SECONDS = 60;
const JWT_TTL_SECONDS = 540;
/** Reuse a signed JWT until it is this close to `exp`. */
const JWT_REUSE_MARGIN_SECONDS = 60;

/** Re-mint an installation token when less than this much life remains. */
const DEFAULT_TOKEN_BUFFER_MS = 5 * 60_000;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Build and sign the App JWT (RS256). Pure: `nowSeconds` is injected so the
 * claims are deterministic under test.
 */
export function buildAppJwt(params: {
  appId: string;
  privateKeyPem: string;
  nowSeconds: number;
}): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iat: params.nowSeconds - JWT_BACKDATE_SECONDS,
      exp: params.nowSeconds + JWT_TTL_SECONDS,
      iss: params.appId,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    createPrivateKey(params.privateKeyPem),
  );
  return `${signingInput}.${base64url(signature)}`;
}

/**
 * The next rung of the permission ladder: `permissions` minus the first
 * `OPTIONAL_MINT_PERMISSIONS` entry (in list order) it still carries, or null
 * when nothing droppable is left. Required permissions are never removed —
 * a rejection for one of those must surface, not silently downgrade.
 */
export function nextPermissionSet(
  permissions: Record<string, string>,
): Record<string, string> | null {
  const droppable = OPTIONAL_MINT_PERMISSIONS.find((p) => p in permissions);
  if (!droppable) return null;
  const { [droppable]: _dropped, ...rest } = permissions;
  return rest;
}

/** GitHub mints an installation token for at most this many repositories. */
export const MAX_TOKEN_REPOSITORIES = 500;

export interface InstallationTokenOptions {
  /** Repository names (without owner) the token is restricted to. Omit for every repo. */
  repositories?: string[];
  /**
   * Repository ids the token is restricted to, for a scope that has to survive
   * a rename. Mutually exclusive with `repositories`; omit both for every repo.
   */
  repositoryIds?: number[];
  /** Permissions to request; omit for everything the installation grants. */
  permissions?: Record<string, string>;
  /** Re-mint when less than this many ms of life remain. */
  bufferMs?: number;
  /** The upstream just rejected the token: skip the cache. */
  forceRefresh?: boolean;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  /** The permissions GitHub actually granted, which may be fewer than requested. */
  permissions: Record<string, string>;
}

/**
 * Why this token scope cannot be minted, or null when it can.
 *
 * The empty list is the dangerous case. GitHub reads it as "no restriction"
 * and answers with a token for every repository of the installation, so a
 * caller whose scope computed down to nothing must fail rather than be
 * silently widened past what it asked for.
 */
export function invalidTokenScope(
  opts: Pick<InstallationTokenOptions, "repositories" | "repositoryIds">,
): string | null {
  const { repositories, repositoryIds } = opts;
  if (repositories && repositoryIds) {
    return "A GitHub installation token is scoped by repository name or by id, never both";
  }
  const size = repositories?.length ?? repositoryIds?.length;
  if (size !== undefined && (size === 0 || size > MAX_TOKEN_REPOSITORIES)) {
    return `A GitHub installation token covers 1 to ${MAX_TOKEN_REPOSITORIES} repositories, not ${size}`;
  }
  if (repositoryIds?.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    return "A GitHub repository id must be a positive integer";
  }
  return null;
}

/**
 * Cache key for an installation token request. Order-insensitive: the same
 * set of repositories and permissions must hit the same entry however the
 * caller spelled them. GitHub matches repository names case-insensitively.
 *
 * A scope by id is a different token from the same scope spelled as names, and
 * both differ from the unrestricted one, so the ids get their own segment with
 * a marker for "no id restriction".
 */
export function installationCacheKey(
  installationId: number,
  opts: Pick<
    InstallationTokenOptions,
    "repositories" | "repositoryIds" | "permissions"
  >,
): string {
  const repositories = (opts.repositories ?? [])
    .map((r) => r.toLowerCase())
    .sort();
  const permissions = Object.entries(opts.permissions ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const ids = opts.repositoryIds
    ? `ids:${[...opts.repositoryIds].sort((a, b) => a - b).join(",")}`
    : "all";
  return `${installationId}|${repositories.join(",")}|${ids}|${permissions.join(",")}`;
}

/**
 * Remove every entry in `cache` that has already expired.
 *
 * Cache keys are per (installation, repositories, permissions) — a busy
 * deployment mints one entry per distinct repository an installation ever
 * touches, and nothing ever removed a stale one, so the map only grew for the
 * life of the process. Called opportunistically on every mint, which bounds
 * it to roughly the installations/repos actually touched inside one token
 * lifetime rather than every one ever seen.
 */
export function pruneExpiredTokens(
  cache: Map<string, InstallationToken>,
  now: number,
): void {
  for (const [key, token] of cache) {
    if (token.expiresAt.getTime() <= now) cache.delete(key);
  }
}

/** Neutral shape of a GitHub App installation, as the account layer stores it. */
export interface GithubInstallation {
  installationId: number;
  externalAccountId: string;
  login: string;
  avatarUrl: string | null;
  /** "User" or "Organization". */
  accountType: string;
}

/**
 * An installation the user may choose repositories from.
 *
 * `repositoryIds: null` means the user owns the account and may choose any
 * installed repository. A list identifies repositories they administer.
 * The persisted workspace grant is always a separate, explicit selection.
 */
export interface AuthorizedInstallation extends GithubInstallation {
  repositoryIds: number[] | null;
}

/** `GET /user/installations/{id}/repositories`, as the grant walk reads it. */
const InstallationRepositoriesSchema = z.object({
  repositories: z.array(
    z.object({
      id: z.number().int().positive().safe(),
      permissions: z.object({ admin: z.boolean().optional() }).optional(),
    }),
  ),
});

interface InstallationJson {
  id?: unknown;
  account?: {
    id?: unknown;
    login?: unknown;
    avatar_url?: unknown;
    type?: unknown;
  } | null;
}

/**
 * Map GitHub's installation object. Null when the entry has no account —
 * enterprise-target installations carry a different owner shape and nothing
 * in Studio can act on them.
 */
export function mapInstallation(
  json: InstallationJson,
): GithubInstallation | null {
  const account = json.account;
  if (
    typeof json.id !== "number" ||
    !account ||
    typeof account.id !== "number" ||
    typeof account.login !== "string"
  ) {
    return null;
  }
  return {
    installationId: json.id,
    externalAccountId: String(account.id),
    login: account.login,
    avatarUrl:
      typeof account.avatar_url === "string" ? account.avatar_url : null,
    accountType: typeof account.type === "string" ? account.type : "User",
  };
}

interface AccessTokenJson {
  token?: unknown;
  expires_at?: unknown;
  permissions?: unknown;
}

function grantedPermissions(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export class GithubAppAuth {
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly apiBaseUrl: string;

  private jwt: { value: string; exp: number } | null = null;
  private readonly cache = new Map<string, InstallationToken>();
  private readonly inFlight = new Map<string, Promise<InstallationToken>>();

  constructor(config: GithubAppConfig, opts?: { apiBaseUrl?: string }) {
    this.appId = config.appId;
    this.privateKeyPem = config.privateKeyPem;
    this.apiBaseUrl = (opts?.apiBaseUrl ?? DEFAULT_API_BASE_URL).replace(
      /\/+$/,
      "",
    );
  }

  /** A valid App JWT, re-signed only when the previous one is near expiry. */
  appJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && this.jwt.exp - now > JWT_REUSE_MARGIN_SECONDS) {
      return this.jwt.value;
    }
    const value = buildAppJwt({
      appId: this.appId,
      privateKeyPem: this.privateKeyPem,
      nowSeconds: now,
    });
    this.jwt = { value, exp: now + JWT_TTL_SECONDS };
    rememberBudgetOwner(
      value,
      APP_BUDGET_OWNER,
      (now + JWT_TTL_SECONDS) * 1000,
    );
    return value;
  }

  /**
   * An installation access token, from cache while it has more than
   * `bufferMs` of life left. Concurrent callers for the same key share one
   * mint; `forceRefresh` skips the cache but still joins an in-flight mint,
   * since that one is already fresh.
   */
  installationToken(
    installationId: number,
    opts: InstallationTokenOptions = {},
  ): Promise<InstallationToken> {
    const invalidScope = invalidTokenScope(opts);
    if (invalidScope) {
      return Promise.reject(
        new GitProviderError({
          provider: "github",
          status: 403,
          message: invalidScope,
        }),
      );
    }
    const key = installationCacheKey(installationId, opts);
    const bufferMs = opts.bufferMs ?? DEFAULT_TOKEN_BUFFER_MS;

    if (!opts.forceRefresh) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt.getTime() - Date.now() > bufferMs) {
        return Promise.resolve(cached);
      }
    }
    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const mint = this.mint(installationId, opts)
      .then((token) => {
        this.cache.set(key, token);
        rememberBudgetOwner(
          token.token,
          String(installationId),
          token.expiresAt.getTime(),
        );
        pruneExpiredTokens(this.cache, Date.now());
        return token;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, mint);
    return mint;
  }

  /**
   * `POST /app/installations/{id}/access_tokens`, shedding optional
   * permissions one rung at a time when GitHub 422s because the installation
   * has not granted them (same ladder as `mintRepoTokenWithFallback`).
   */
  private async mint(
    installationId: number,
    opts: InstallationTokenOptions,
  ): Promise<InstallationToken> {
    const operation = "installation_access_token";
    const url = `${this.apiBaseUrl}/app/installations/${installationId}/access_tokens`;
    const repositories =
      opts.repositories && opts.repositories.length > 0
        ? opts.repositories
        : undefined;
    let permissions = opts.permissions ? { ...opts.permissions } : undefined;

    for (;;) {
      const res = await githubFetch(url, {
        method: "POST",
        token: this.appJwt(),
        body: {
          ...(repositories && { repositories }),
          ...(opts.repositoryIds && { repository_ids: opts.repositoryIds }),
          ...(permissions && { permissions }),
        },
        operation,
      });

      if (res.ok) {
        const json = await githubJson<AccessTokenJson>(res, operation);
        if (
          typeof json.token !== "string" ||
          typeof json.expires_at !== "string"
        ) {
          throw new GitProviderError({
            provider: "github",
            status: res.status,
            message: `GitHub ${operation} returned no token`,
          });
        }
        return {
          token: json.token,
          expiresAt: new Date(json.expires_at),
          permissions:
            grantedPermissions(json.permissions) ?? permissions ?? {},
        };
      }

      if (res.status === 422 && permissions) {
        const text = await res.text().catch(() => "");
        const next = nextPermissionSet(permissions);
        if (next && isPermissionRejected(githubErrorMessage(text))) {
          permissions = next;
          continue;
        }
        throw githubFailureFromBody(res.status, text, operation);
      }

      throw await githubFailure(res, operation);
    }
  }

  /** `GET /app/installations/{id}`; null when the installation no longer exists. */
  async getInstallation(
    installationId: number,
  ): Promise<GithubInstallation | null> {
    const operation = "get_installation";
    const res = await githubFetch(
      `${this.apiBaseUrl}/app/installations/${installationId}`,
      { token: this.appJwt(), operation },
    );
    if (res.status === 404) return null;
    if (!res.ok) throw await githubFailure(res, operation);
    const mapped = mapInstallation(
      await githubJson<InstallationJson>(res, operation),
    );
    if (!mapped) {
      throw new GitProviderError({
        provider: "github",
        status: res.status,
        message: `GitHub ${operation} returned an installation without a user or organization account`,
      });
    }
    return mapped;
  }

  /**
   * The installations this user may delegate from. This is their authority
   * ceiling; the connect route separately validates the selected repositories.
   *
   * GitHub lists an installation whenever the user can see a single repository
   * in it, and seeing a repository is not authority over the rest of the
   * account. So the answer is narrowed to what the user can actually authorize:
   *
   * - their own personal account (`repositoryIds: null`);
   * - an organization they own, where they may choose any installed repo;
   * - otherwise, only the repositories of that installation they administer,
   *   which is exactly the set GitHub would let them install the App on.
   *
   * An installation where none of that holds is left out entirely.
   */
  async listAuthorizedInstallations(userToken: string): Promise<{
    userId: string;
    installations: AuthorizedInstallation[];
  }> {
    const user = z
      .object({ id: z.number().int().positive().safe() })
      .parse(await this.userGet("/user", userToken, "get_connecting_user"));
    const installations = await this.listUserInstallations(userToken);
    const ownedOrganizations = new Set<string>();
    if (installations.some((item) => item.accountType === "Organization")) {
      for (let page = 1; ; page++) {
        // Unlike the per-org membership endpoint, this requires no extra App permissions.
        const memberships = z
          .array(
            z.object({
              state: z.string(),
              role: z.string(),
              organization: z.object({
                id: z.number().int().positive().safe(),
              }),
            }),
          )
          .parse(
            await this.userGet(
              `/user/memberships/orgs?state=active&per_page=100&page=${page}`,
              userToken,
              "list_connecting_user_memberships",
            ),
          );
        for (const membership of memberships) {
          if (membership.state === "active" && membership.role === "admin") {
            ownedOrganizations.add(String(membership.organization.id));
          }
        }
        if (memberships.length < 100) break;
      }
    }
    const authorized: AuthorizedInstallation[] = [];
    for (const item of installations) {
      if (item.accountType === "User") {
        if (item.externalAccountId === String(user.id)) {
          authorized.push({ ...item, repositoryIds: null });
        }
        continue;
      }
      if (ownedOrganizations.has(item.externalAccountId)) {
        authorized.push({ ...item, repositoryIds: null });
        continue;
      }
      const repositoryIds = await this.administeredRepositories(
        userToken,
        item.installationId,
      );
      if (repositoryIds.length > 0) authorized.push({ ...item, repositoryIds });
    }
    return { userId: String(user.id), installations: authorized };
  }

  /** Repository choices use the temporary user grant, never an installation token. */
  async listRepositoryChoices(
    userToken: string,
    installation: AuthorizedInstallation,
    page: number,
  ) {
    const result = z
      .object({
        repositories: z.array(
          z.object({
            id: z.number().int().positive().safe(),
            full_name: z.string().min(1),
            permissions: z.object({ admin: z.boolean().optional() }).optional(),
          }),
        ),
      })
      .parse(
        await this.userGet(
          `/user/installations/${installation.installationId}/repositories?per_page=100&page=${page}`,
          userToken,
          "list_repository_choices",
        ),
      );
    return {
      repositories: result.repositories
        .filter(
          (repo) =>
            installation.repositoryIds === null ||
            repo.permissions?.admin === true,
        )
        .map((repo) => ({ id: repo.id, name: repo.full_name })),
      hasMore: result.repositories.length === 100,
    };
  }

  /** Recheck every selected id against current installation membership and admin access. */
  async canAuthorizeRepositories(
    userToken: string,
    installation: AuthorizedInstallation,
    repositoryIds: number[],
  ): Promise<boolean> {
    const remaining = new Set(repositoryIds);
    for (let page = 1; ; page++) {
      const choices = await this.listRepositoryChoices(
        userToken,
        installation,
        page,
      );
      for (const repo of choices.repositories) remaining.delete(repo.id);
      if (remaining.size === 0) return true;
      if (!choices.hasMore) return false;
    }
  }

  /**
   * The repositories of one installation the user administers, by id.
   *
   * Ids rather than names because the grant outlives a rename. The walk stops
   * at `MAX_TOKEN_REPOSITORIES`: a token cannot be minted for more than that
   * anyway. Repository selection and validation paginate independently, so
   * this preview count never limits which repositories the user can select.
   */
  private async administeredRepositories(
    userToken: string,
    installationId: number,
  ): Promise<number[]> {
    const perPage = 100;
    const administered: number[] = [];
    for (let page = 1; ; page++) {
      const { repositories } = InstallationRepositoriesSchema.parse(
        await this.userGet(
          `/user/installations/${installationId}/repositories?per_page=${perPage}&page=${page}`,
          userToken,
          "list_connecting_user_repositories",
        ),
      );
      for (const repository of repositories) {
        if (repository.permissions?.admin !== true) continue;
        administered.push(repository.id);
        if (administered.length === MAX_TOKEN_REPOSITORIES) return administered;
      }
      if (repositories.length < perPage) return administered;
    }
  }

  private async userGet(
    path: string,
    token: string,
    operation: string,
  ): Promise<unknown> {
    const response = await githubFetch(`${this.apiBaseUrl}${path}`, {
      token,
      operation,
    });
    if (!response.ok) throw await githubFailure(response, operation);
    return githubJson<unknown>(response, operation);
  }

  /**
   * Every installation of this App the user can access, via their
   * user-to-server token: `GET /user/installations`, paginated.
   */
  private async listUserInstallations(
    userToken: string,
  ): Promise<GithubInstallation[]> {
    const operation = "list_user_installations";
    const perPage = 100;
    const installations: GithubInstallation[] = [];
    for (let page = 1; ; page++) {
      const res = await githubFetch(
        `${this.apiBaseUrl}/user/installations?per_page=${perPage}&page=${page}`,
        { token: userToken, operation },
      );
      if (!res.ok) throw await githubFailure(res, operation);
      const body = await githubJson<{ installations?: InstallationJson[] }>(
        res,
        operation,
      );
      const entries = Array.isArray(body.installations)
        ? body.installations
        : [];
      for (const entry of entries) {
        const mapped = mapInstallation(entry);
        if (mapped) installations.push(mapped);
      }
      if (entries.length < perPage) return installations;
    }
  }
}

let appAuthSingleton: GithubAppAuth | null | undefined;

/**
 * The process-wide App signer, or null when this deployment has no App
 * registered. One instance because its installation-token cache lives inside
 * it: a second signer would mint a second token per installation and halve
 * the cache's usefulness.
 *
 * Lives here rather than in the credential ladder so that the ladder — which
 * is provider-neutral — holds no GitHub state of its own.
 */
export function getGithubAppAuth(): GithubAppAuth | null {
  if (appAuthSingleton === undefined) {
    const config = readGithubAppConfig();
    appAuthSingleton =
      config && usableAppKey(config)
        ? new GithubAppAuth(config, {
            apiBaseUrl: githubApiBaseUrl("github.com"),
          })
        : null;
  }
  return appAuthSingleton;
}

/**
 * Whether the configured private key can actually sign — checked HERE, at the
 * gate, rather than at the first mint.
 *
 * `readGithubAppConfig` only proves five environment variables are non-empty,
 * and a PEM mangled on the way into a secret manager (the newlines eaten, the
 * classic one) is a perfectly good non-empty string. Without this check that
 * key still makes `getGithubAppAuth()` non-null, which makes every backfilled
 * account `accountIsServable`, which takes every GitHub repository OFF its
 * legacy connection and onto an App that cannot sign — turning a bad paste
 * into an outage instead of a no-op.
 *
 * Answering null instead leaves the whole feature dormant and every org on the
 * path it is already using, which is what a misconfiguration should cost.
 *
 * Exported for its test: the singleton above memoizes, so only the predicate
 * can be exercised across more than one configuration in a process.
 */
export function usableAppKey(config: GithubAppConfig): boolean {
  try {
    createPrivateKey(config.privateKeyPem);
    return true;
  } catch (cause) {
    console.error(
      "[git-providers] GITHUB_APP_PRIVATE_KEY is not a usable private key — " +
        "the GitHub App stays disabled and orgs keep their existing " +
        "connections. Check that newlines survived the secret store.",
      cause,
    );
    return false;
  }
}

/**
 * The App serves github.com only — GitHub Enterprise needs its own App
 * registered per instance, which this deployment has no config for. So the
 * host list is a constant here rather than a setting.
 */
const GITHUB_APP_HOST = "github.com";

export function githubCapability(): GitProviderCapability {
  /**
   * BOTH a readable config and a signer built from it: a malformed PEM parses
   * as config and then fails at the first mint, which is a worse answer than
   * "not configured".
   */
  const configured =
    readGithubAppConfig() !== null && getGithubAppAuth() !== null;
  return { configured, hosts: configured ? [GITHUB_APP_HOST] : [] };
}
