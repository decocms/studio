/**
 * Git Provider abstraction.
 *
 * Mirrors `apps/mesh/src/ai-providers/` in spirit: a registry of adapters,
 * a factory that resolves a per-call client, and per-adapter implementations
 * that know how to talk to a specific git host.
 *
 * Today only the GitHub adapter (backed by the Decobot GitHub App) is
 * implemented. The interface is shaped so future GitLab/Bitbucket adapters
 * can plug in without changing call sites.
 *
 * Identity contract (the whole reason this subsystem exists):
 *   - A real user calling a tool acts on GitHub via their *user-to-server*
 *     token — the API call shows up as the human in the audit log.
 *   - An unattended caller (cron, event-bus handler, scheduled workflow)
 *     acts via an *installation token* — the call shows up as Decobot.
 *   - A real user with no linked GitHub identity gets a structured
 *     `GitProviderUserLinkRequiredError` so the UI can prompt them to link.
 */

import type { MeshContext } from "../core/mesh-context";

export type GitProviderId = "github";

export interface GitProviderInfo {
  id: GitProviderId;
  name: string;
  description: string;
  logo?: string;
  /**
   * Whether this provider is configured on the current Studio instance.
   * For GitHub: requires the full set of DECOBOT_* env vars.
   * If false, the UI shows "not configured" instead of a Connect button.
   */
  available: boolean;
}

/**
 * Outcome of `resolveClient`: either a user-to-server token (real user, linked
 * account) or an installation token (no user in context). Tools use `actor`
 * to e.g. append a "via Decobot" footer to write payloads when running as bot.
 */
export interface ResolvedGitClient {
  /** Bearer token for the GitHub REST/GraphQL APIs. */
  token: string;
  /** Whether this token represents a human user or the bot. */
  actor: "user" | "bot";
  /** GitHub login of the user if `actor === "user"`, else the App slug. */
  actorLogin?: string;
  /** Installation id this client is bound to. */
  installationId: string;
  /** Account login (org or user) the installation is on. */
  accountLogin: string;
}

/**
 * Thrown by `resolveClient` when the caller is a real user but hasn't linked
 * their GitHub identity to Studio. The frontend tool-call renderer turns this
 * into an inline "Link your GitHub to continue" CTA pointed at `linkUrl`.
 */
export class GitProviderUserLinkRequiredError extends Error {
  readonly code = "GIT_PROVIDER_USER_LINK_REQUIRED" as const;
  constructor(
    readonly providerId: GitProviderId,
    readonly linkUrl: string,
    message = "Link your GitHub account to continue.",
  ) {
    super(message);
    this.name = "GitProviderUserLinkRequiredError";
  }
}

/**
 * Thrown by `resolveClient` when this Studio org has no Decobot installation
 * covering the requested repo owner. Surfaced to agents as a structured error
 * so they can suggest "ask an org admin to install Decobot on {owner}".
 */
export class GitProviderNotInstalledError extends Error {
  readonly code = "GIT_PROVIDER_NOT_INSTALLED" as const;
  constructor(
    readonly providerId: GitProviderId,
    readonly accountLogin: string,
    message = `No Decobot installation found for "${accountLogin}". An org admin must install the GitHub App.`,
  ) {
    super(message);
    this.name = "GitProviderNotInstalledError";
  }
}

/**
 * Thrown when no Git Provider is configured on this Studio instance at all
 * (i.e. self-hosters haven't set the DECOBOT_* env vars yet).
 */
export class GitProviderNotConfiguredError extends Error {
  readonly code = "GIT_PROVIDER_NOT_CONFIGURED" as const;
  constructor(
    readonly providerId: GitProviderId,
    message = `${providerId} provider is not configured on this Studio instance.`,
  ) {
    super(message);
    this.name = "GitProviderNotConfiguredError";
  }
}

/**
 * Per-adapter contract. The adapter knows how to mint installation tokens,
 * read per-user tokens from auth storage, build the install URL, and fetch
 * account metadata after an install callback. It does NOT know about
 * org-scoped state — that's the storage layer.
 */
export interface GitProviderAdapter {
  readonly info: GitProviderInfo;

  /**
   * URL the user is redirected to in order to install the App on a GitHub
   * org/account. `state` is a single-use opaque token the callback must
   * present back; it's how we tie the install back to the Studio org/user
   * that initiated the flow.
   */
  buildInstallUrl(params: { state: string; baseUrl: string }): string;

  /**
   * Look up an installation by id at the provider (server-to-server, via App
   * JWT). Called by the install-callback tool to fetch account metadata.
   */
  fetchInstallation(installationId: string): Promise<{
    installationId: string;
    accountLogin: string;
    accountId: string;
    accountType: "Organization" | "User";
    repositorySelection: "all" | "selected";
  }>;

  /**
   * Mint an installation access token (1h, server-to-server). The adapter
   * caches these internally — callers should not worry about expiry.
   */
  getInstallationToken(installationId: string): Promise<string>;

  /**
   * Look up the per-user GitHub access token stored by Better Auth for the
   * given Studio user. Returns `undefined` when the user hasn't linked.
   * Adapter is responsible for refreshing expired tokens transparently.
   */
  getUserAccessToken(
    ctx: MeshContext,
    userId: string,
  ): Promise<{ token: string; login?: string } | undefined>;

  /**
   * URL the user is sent to in order to link their personal GitHub identity
   * (Better Auth social provider link flow).
   */
  buildUserLinkUrl(params: { baseUrl: string; redirectTo?: string }): string;
}
