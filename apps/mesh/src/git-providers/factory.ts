/**
 * GitProviderFactory — the single entry point Studio's GitHub tools use to
 * get an authenticated client for a repo.
 *
 * Implements the four-quadrant identity matrix:
 *
 *                     calling context
 *                  user session?      no user (cron, event-bus)
 *   linked GitHub?  ─────────────     ──────────────────────────
 *   yes             user-to-server    installation token (bot)
 *   no              ERROR (link req)  installation token (bot)
 *
 * The whole point of this subsystem is identity attribution on GitHub: a tool
 * invoked by a real user must act as that user on GitHub, not as the connection
 * creator. See the plan in
 * /Users/guilherme/.claude/plans/system-instruction-you-are-working-calm-octopus.md.
 */

import type { MeshContext } from "../core/mesh-context";
import type { GitProviderInstallationStorage } from "../storage/git-provider-installations";
import { getGitProvider } from "./registry";
import {
  GitProviderNotConfiguredError,
  GitProviderNotInstalledError,
  GitProviderUserLinkRequiredError,
  type GitProviderAdapter,
  type GitProviderId,
  type ResolvedGitClient,
} from "./types";

/**
 * Optional injection point for tests — production code uses the real registry.
 * Lets `factory.test.ts` swap in a stub adapter without monkey-patching modules.
 */
export interface GitProviderFactoryOptions {
  adapterResolver?: (id: GitProviderId) => GitProviderAdapter;
}

export class GitProviderFactory {
  private adapterResolver: (id: GitProviderId) => GitProviderAdapter;

  constructor(
    private installations: GitProviderInstallationStorage,
    options: GitProviderFactoryOptions = {},
  ) {
    this.adapterResolver = options.adapterResolver ?? getGitProvider;
  }

  /**
   * Resolve a GitHub client for a tool call.
   *
   * `owner` is the repo owner (the GitHub account login that owns the repo,
   * e.g. "deco-cx"). We need it to find which installation in this org has
   * permission to talk to that repo — an org can install Decobot on multiple
   * GitHub accounts, and we don't want to leak permissions across them.
   */
  async resolveClient(
    ctx: MeshContext,
    params: { owner: string; providerId?: GitProviderId },
  ): Promise<ResolvedGitClient> {
    const providerId: GitProviderId = params.providerId ?? "github";
    const adapter = this.adapterResolver(providerId);

    if (!adapter.info.available) {
      throw new GitProviderNotConfiguredError(providerId);
    }

    const orgId = ctx.organization?.id;
    if (!orgId) {
      // Tool calls outside an org scope can't have a Decobot installation —
      // fail closed rather than reaching for any installation we can find.
      throw new GitProviderNotInstalledError(providerId, params.owner);
    }

    const installation = await this.installations.findByOrgAndOwner(
      orgId,
      providerId,
      params.owner,
    );
    if (!installation) {
      throw new GitProviderNotInstalledError(providerId, params.owner);
    }

    const userId = ctx.auth.user?.id;

    if (userId) {
      // Real user in context → must act as them on GitHub. Fall back is
      // explicit: no link → structured error so the UI can prompt to link.
      // We do NOT silently use the bot token here — that would defeat the
      // whole point of this feature.
      const userToken = await adapter.getUserAccessToken(ctx, userId);
      if (!userToken) {
        const linkUrl = adapter.buildUserLinkUrl({
          baseUrl: ctx.baseUrl,
        });
        throw new GitProviderUserLinkRequiredError(providerId, linkUrl);
      }
      return {
        token: userToken.token,
        actor: "user",
        actorLogin: userToken.login,
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
      };
    }

    // No user in context (cron, event-bus handler, scheduled workflow) →
    // act as the bot. Tools that write to GitHub should append a "via Decobot"
    // footer to their payloads so attribution survives on GitHub itself.
    const installationToken = await adapter.getInstallationToken(
      installation.installationId,
    );
    return {
      token: installationToken,
      actor: "bot",
      actorLogin: "decobot",
      installationId: installation.installationId,
      accountLogin: installation.accountLogin,
    };
  }
}
