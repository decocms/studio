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
import {
  isPermissionRejected,
  OPTIONAL_MINT_PERMISSIONS,
} from "@decocms/shared/github-repo-scope";
import type { GithubAppConfig } from "../env";
import { GitProviderError } from "../types";
import {
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

export interface InstallationTokenOptions {
  /** Repository names (without owner) the token is restricted to. Omit for every repo. */
  repositories?: string[];
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
 * Cache key for an installation token request. Order-insensitive: the same
 * set of repositories and permissions must hit the same entry however the
 * caller spelled them. GitHub matches repository names case-insensitively.
 */
export function installationCacheKey(
  installationId: number,
  opts: Pick<InstallationTokenOptions, "repositories" | "permissions">,
): string {
  const repositories = (opts.repositories ?? [])
    .map((r) => r.toLowerCase())
    .sort();
  const permissions = Object.entries(opts.permissions ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  return `${installationId}|${repositories.join(",")}|${permissions.join(",")}`;
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
   * Every installation of this App the user can access, via their
   * user-to-server token: `GET /user/installations`, paginated.
   */
  async listUserInstallations(
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
