/**
 * Four-quadrant identity matrix tests for `GitProviderFactory.resolveClient`.
 *
 * This is the heart of the Git Provider subsystem — it decides whether a tool
 * call acts as the calling user (user-to-server token) or the bot (installation
 * token). Each combination must behave correctly; getting any one wrong
 * reintroduces the impersonation bug this feature exists to fix.
 *
 *                     calling context
 *                  user session?      no user (cron, event-bus)
 *   linked GitHub?  ─────────────     ──────────────────────────
 *   yes             user-to-server    installation token (bot)
 *   no              ERROR (link req)  installation token (bot)
 */

import { describe, expect, test } from "bun:test";
import { GitProviderFactory } from "./factory";
import {
  GitProviderNotConfiguredError,
  GitProviderNotInstalledError,
  GitProviderUserLinkRequiredError,
  type GitProviderAdapter,
} from "./types";
import type { GitProviderInstallationStorage } from "../storage/git-provider-installations";
import type { GitProviderInstallationInfo } from "../storage/types";
import type { MeshContext } from "../core/mesh-context";

const FAKE_INSTALLATION: GitProviderInstallationInfo = {
  id: "gpi_test",
  providerId: "github",
  installationId: "999",
  accountLogin: "deco-cx",
  accountId: "1",
  accountType: "Organization",
  repositorySelection: "all",
  organizationId: "org_1",
  createdBy: "user_1",
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function makeAdapter(opts: {
  available?: boolean;
  userTokens?: Record<string, string>;
}): GitProviderAdapter {
  return {
    info: {
      id: "github",
      name: "GitHub",
      description: "test",
      available: opts.available ?? true,
    },
    buildInstallUrl: () => "https://example/install",
    buildUserLinkUrl: () => "https://example/link",
    fetchInstallation: async () => ({
      installationId: "999",
      accountLogin: "deco-cx",
      accountId: "1",
      accountType: "Organization",
      repositorySelection: "all",
    }),
    getInstallationToken: async () => "ghs_bot_token",
    getUserAccessToken: async (_ctx, userId) => {
      const tok = opts.userTokens?.[userId];
      return tok ? { token: tok, login: "real-user" } : undefined;
    },
  };
}

function makeStorage(
  installations: GitProviderInstallationInfo[] = [FAKE_INSTALLATION],
): GitProviderInstallationStorage {
  return {
    findByOrgAndOwner: async (
      orgId: string,
      _pid: string,
      owner: string,
    ): Promise<GitProviderInstallationInfo | undefined> =>
      installations.find(
        (i) =>
          i.organizationId === orgId &&
          i.accountLogin.toLowerCase() === owner.toLowerCase(),
      ),
  } as unknown as GitProviderInstallationStorage;
}

function makeCtx(opts: { orgId?: string; userId?: string }): MeshContext {
  return {
    organization: opts.orgId ? { id: opts.orgId } : undefined,
    auth: { user: opts.userId ? { id: opts.userId } : undefined },
    baseUrl: "https://studio.example",
  } as unknown as MeshContext;
}

function makeFactory(adapter: GitProviderAdapter) {
  return new GitProviderFactory(makeStorage(), {
    adapterResolver: () => adapter,
  });
}

describe("GitProviderFactory.resolveClient", () => {
  test("Q1: real user + linked GitHub → user-to-server token", async () => {
    const factory = makeFactory(
      makeAdapter({ userTokens: { user_1: "ghu_user_token" } }),
    );
    const ctx = makeCtx({ orgId: "org_1", userId: "user_1" });

    const client = await factory.resolveClient(ctx, { owner: "deco-cx" });
    expect(client.actor).toBe("user");
    expect(client.token).toBe("ghu_user_token");
    expect(client.actorLogin).toBe("real-user");
    expect(client.installationId).toBe("999");
    expect(client.accountLogin).toBe("deco-cx");
  });

  test("Q2: real user + unlinked → GitProviderUserLinkRequiredError (THE BUG FIX)", async () => {
    const factory = makeFactory(makeAdapter({}));
    const ctx = makeCtx({ orgId: "org_1", userId: "user_unlinked" });

    // CRITICAL: we MUST throw rather than silently fall back to the bot
    // token. The whole point of this feature is per-user attribution.
    const promise = factory.resolveClient(ctx, { owner: "deco-cx" });
    await expect(promise).rejects.toBeInstanceOf(
      GitProviderUserLinkRequiredError,
    );
    await expect(promise).rejects.toMatchObject({
      code: "GIT_PROVIDER_USER_LINK_REQUIRED",
      linkUrl: "https://example/link",
    });
  });

  test("Q3: no user + installation present → installation token (bot)", async () => {
    const factory = makeFactory(makeAdapter({}));
    const ctx = makeCtx({ orgId: "org_1" });

    const client = await factory.resolveClient(ctx, { owner: "deco-cx" });
    expect(client.actor).toBe("bot");
    expect(client.token).toBe("ghs_bot_token");
    expect(client.actorLogin).toBe("decobot");
  });

  test("Q4: no user, no user-token state matters → still bot", async () => {
    const factory = makeFactory(makeAdapter({}));
    const ctx = makeCtx({ orgId: "org_1" });

    const client = await factory.resolveClient(ctx, { owner: "deco-cx" });
    expect(client.actor).toBe("bot");
  });

  test("provider not configured (env missing) → GitProviderNotConfiguredError", async () => {
    const factory = makeFactory(makeAdapter({ available: false }));
    const ctx = makeCtx({ orgId: "org_1", userId: "user_1" });

    await expect(
      factory.resolveClient(ctx, { owner: "deco-cx" }),
    ).rejects.toBeInstanceOf(GitProviderNotConfiguredError);
  });

  test("no installation for owner → GitProviderNotInstalledError", async () => {
    const factory = makeFactory(makeAdapter({}));
    const ctx = makeCtx({ orgId: "org_1", userId: "user_1" });

    await expect(
      factory.resolveClient(ctx, { owner: "other-org" }),
    ).rejects.toBeInstanceOf(GitProviderNotInstalledError);
  });

  test("missing organization scope → fails closed (not silently bot)", async () => {
    const factory = makeFactory(makeAdapter({}));
    const ctx = makeCtx({ userId: "user_1" }); // no org

    await expect(
      factory.resolveClient(ctx, { owner: "deco-cx" }),
    ).rejects.toBeInstanceOf(GitProviderNotInstalledError);
  });

  test("owner lookup is case-insensitive", async () => {
    const factory = makeFactory(makeAdapter({}));
    const ctx = makeCtx({ orgId: "org_1" });

    const client = await factory.resolveClient(ctx, { owner: "Deco-CX" });
    expect(client.accountLogin).toBe("deco-cx");
  });
});
