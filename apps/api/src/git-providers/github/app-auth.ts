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
import { mapBounded } from "@decocms/shared/std";
import {
  isPermissionRejected,
  OPTIONAL_MINT_PERMISSIONS,
} from "@decocms/shared/github-repo-scope";
import { APP_BUDGET_OWNER, rememberBudgetOwner } from "./budget-owner";
import { type GithubAppConfig, readGithubAppConfig } from "./env";
import type { GitProviderCapability } from "../types";
import { GitProviderError } from "../types";
import {
  CHOICE_PAGE_SIZE,
  delegableRepositories,
  FlowAccessCache,
  type InstallationRepositoriesPage,
  InstallationRepositoriesPageSchema,
  provesNothingDelegable,
  remainingPages,
  type RepositoryChoice,
} from "./connect-access";
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
/** A connect flow's lifetime, and so the lifetime of what it learned. */
const CONNECT_FLOW_TTL_MS = 10 * 60_000;

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
  /** GitHub's own link to this installation's settings page, when it sent one. */
  htmlUrl: string | null;
}

interface InstallationJson {
  id?: unknown;
  html_url?: unknown;
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
    htmlUrl: typeof json.html_url === "string" ? json.html_url : null,
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
  private readonly flowAccess = new FlowAccessCache(CONNECT_FLOW_TTL_MS);

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
          json.token.length === 0 ||
          typeof json.expires_at !== "string" ||
          json.expires_at.length === 0
        ) {
          throw new GitProviderError({
            provider: "github",
            status: res.status,
            message: `GitHub ${operation} returned no token`,
          });
        }
        const expiresAt = new Date(json.expires_at);
        if (isNaN(expiresAt.getTime())) {
          throw new GitProviderError({
            provider: "github",
            status: res.status,
            message: `GitHub ${operation} returned invalid token expiration`,
          });
        }
        return {
          token: json.token,
          expiresAt,
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
   * The GitHub user behind a user-to-server token, by id. Read once, at
   * connect time, to record who authorized the installation.
   */
  async connectingUserId(userToken: string): Promise<string> {
    const user = z
      .object({ id: z.number().int().positive().safe() })
      .parse(await this.userGet("/user", userToken, "get_connecting_user"));
    return String(user.id);
  }

  /**
   * The installations a connect flow may choose from: every installation of
   * this App the user can see, minus those where the first repository page
   * proves they administer nothing. GitHub lists an installation whenever the
   * user can see a single repository in it, and seeing a repository is not
   * authority over it, so a collaborator's personal account or an
   * organization they merely belong to is left out.
   *
   * One `GET /user/installations` plus one repository page per installation,
   * bounded in parallel; that page seeds the picker's cache, so opening a
   * small account costs nothing more. Calling this is the flow's refresh
   * signal, so it starts by forgetting what the flow had cached.
   */
  async listConnectableInstallations(
    flowId: string,
    userToken: string,
  ): Promise<GithubInstallation[]> {
    this.flowAccess.forget(flowId);
    const installations = await this.listUserInstallations(userToken);
    this.flowAccess.rememberInstallations(flowId, installations);
    const connectable = await mapBounded(installations, 4, async (item) => {
      const first = await this.repositoryPage(
        userToken,
        item.installationId,
        1,
      );
      if (remainingPages(first) === 0) {
        this.flowAccess.rememberRepositories(
          flowId,
          item.installationId,
          delegableRepositories(first),
        );
      }
      return provesNothingDelegable(first) ? null : item;
    });
    return connectable.filter((item) => item !== null);
  }

  /**
   * One installation of the flow, from the flow's cache or a fresh
   * `GET /user/installations`; null when the user cannot see it. `fresh`
   * skips the cache, for the connect's judgement of current access.
   */
  async connectableInstallation(
    flowId: string,
    userToken: string,
    installationId: number,
    opts: { fresh?: boolean } = {},
  ): Promise<GithubInstallation | null> {
    let installations = opts.fresh
      ? undefined
      : this.flowAccess.installations(flowId);
    if (!installations) {
      installations = await this.listUserInstallations(userToken);
      this.flowAccess.rememberInstallations(flowId, installations);
    }
    return (
      installations.find((item) => item.installationId === installationId) ??
      null
    );
  }

  /**
   * Every repository of the installation the user administers, from the
   * flow's cache or one bounded walk of `GET /user/installations/{id}/
   * repositories`. `fresh` skips the cache: the connect itself must judge
   * current GitHub state, not what the chooser saw minutes ago.
   */
  async delegableRepositories(
    flowId: string,
    userToken: string,
    installationId: number,
    opts: { fresh?: boolean } = {},
  ): Promise<RepositoryChoice[]> {
    if (!opts.fresh) {
      const cached = this.flowAccess.repositories(flowId, installationId);
      if (cached) return cached;
    }
    const first = await this.repositoryPage(userToken, installationId, 1);
    const pages = [first];
    const remaining = remainingPages(first);
    if (remaining > 0) {
      pages.push(
        ...(await mapBounded(
          Array.from({ length: remaining }, (_, index) => index + 2),
          4,
          (page) => this.repositoryPage(userToken, installationId, page),
        )),
      );
    } else if (remaining < 0) {
      for (
        let page = 2;
        pages[pages.length - 1]!.repositories.length === CHOICE_PAGE_SIZE;
        page++
      ) {
        pages.push(await this.repositoryPage(userToken, installationId, page));
      }
    }
    const repositories = pages.flatMap(delegableRepositories);
    this.flowAccess.rememberRepositories(flowId, installationId, repositories);
    return repositories;
  }

  /** The flow ended; nothing it learned is worth keeping. */
  forgetFlow(flowId: string): void {
    this.flowAccess.forget(flowId);
  }

  private async repositoryPage(
    userToken: string,
    installationId: number,
    page: number,
  ): Promise<InstallationRepositoriesPage> {
    return InstallationRepositoriesPageSchema.parse(
      await this.userGet(
        `/user/installations/${installationId}/repositories?per_page=${CHOICE_PAGE_SIZE}&page=${page}`,
        userToken,
        "list_connecting_user_repositories",
      ),
    );
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
