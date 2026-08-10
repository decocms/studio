/**
 * End-to-end tests for the per-org GitHub repo → volume sync configs
 * (ORG_REPO_SYNC_* tools).
 *
 * The wire contract under test: an org member points a repo-scoped
 * `mcp-github` connection at a fresh org-fs volume; the config is org-scoped,
 * validated at create time (volume grammar, reserved names, empty-volume
 * requirement, connection tenancy + repoScope shape), and a failed sync is
 * folded into the config's `lastSyncError` instead of failing the tool.
 *
 * OUT OF SCOPE: a successful end-to-end sync. That needs a real GitHub App
 * installation token minted through the live `deco/mcp-github` MCP, which is
 * not reproducible in a hermetic run (same boundary as
 * github-import-repo-scope.spec.ts). The sync/diff machinery itself is
 * unit-tested in apps/api/src/file-storage/skill-set-sync.test.ts.
 */

import type { APIRequestContext } from "@playwright/test";
import { signUpViaApi } from "../fixtures/auth-api";
import { callSelfMcpTool, createHttpConnection } from "../fixtures/mcp-tools";
import { expect, newApiContext, test } from "../fixtures/test";

interface SyncConfig {
  id: string;
  connectionId: string;
  repoOwner: string;
  repoName: string;
  ref: string;
  volume: string;
  enabled: boolean;
  lastSyncedAt: string | null;
  lastSyncError: string | null;
}

/** A connection carrying a repoScope recipe (no source → mint fails fast). */
async function createRepoScopedConnection(
  ctx: APIRequestContext,
  org: string,
): Promise<string> {
  const created = await callSelfMcpTool<{ item: { id: string } }>(
    ctx,
    org,
    "COLLECTION_CONNECTIONS_CREATE",
    {
      data: {
        title: `GitHub: acme/widget ${Date.now()}`,
        app_name: "mcp-github",
        connection_type: "HTTP",
        connection_url: "https://example.com/mcp",
        metadata: {
          repoScope: {
            installationId: 1,
            repositoryId: 99,
            owner: "acme",
            repo: "widget",
            permissions: { contents: "read" },
          },
        },
      },
    },
  );
  expect(created.item.id).toBeTruthy();
  return created.item.id;
}

test.describe("org repo sync configs", () => {
  test("create validates volume names, tenancy, and repoScope shape", async ({
    playwright,
  }) => {
    const ctxA = await newApiContext(playwright);
    const ctxB = await newApiContext(playwright);
    try {
      const userA = await signUpViaApi(ctxA);
      const orgA = userA.orgSlug;
      const repoConnA = await createRepoScopedConnection(ctxA, orgA);

      // Reserved / invalid volume names are rejected up front.
      for (const volume of ["home", "uploads", "public", "public-core", ".x"]) {
        await expect(
          callSelfMcpTool(ctxA, orgA, "ORG_REPO_SYNC_CREATE", {
            connectionId: repoConnA,
            volume,
          }),
        ).rejects.toThrow(/reserved|Invalid/i);
      }

      // A connection without a repoScope recipe is not a sync source.
      const plainConn = await createHttpConnection(ctxA, orgA, {
        title: `Plain conn ${Date.now()}`,
        url: "https://example.com/mcp",
      });
      await expect(
        callSelfMcpTool(ctxA, orgA, "ORG_REPO_SYNC_CREATE", {
          connectionId: plainConn.id,
          volume: "from-plain",
        }),
      ).rejects.toThrow(/repo-scoped/);

      // Another org cannot use org A's connection (tenancy by lookup).
      const userB = await signUpViaApi(ctxB);
      await expect(
        callSelfMcpTool(ctxB, userB.orgSlug, "ORG_REPO_SYNC_CREATE", {
          connectionId: repoConnA,
          volume: "stolen",
        }),
      ).rejects.toThrow(/repo-scoped/);
    } finally {
      await ctxA.dispose();
      await ctxB.dispose();
    }
  });

  test("create requires an empty volume (the sync is a mirror)", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const repoConn = await createRepoScopedConnection(ctx, org);

      // Land a file in the target volume over the normal fs write route.
      const volume = `lived-in-${Date.now()}`;
      const put = await ctx.put(
        `/api/${org}/fs/${volume}/file?path=notes.txt`,
        { data: "hello", headers: { "Content-Type": "text/plain" } },
      );
      expect(put.ok()).toBe(true);

      await expect(
        callSelfMcpTool(ctx, org, "ORG_REPO_SYNC_CREATE", {
          connectionId: repoConn,
          volume,
        }),
      ).rejects.toThrow(/already has .* files/);
    } finally {
      await ctx.dispose();
    }
  });

  test("lifecycle: create → list → run (error recorded) → update → delete", async ({
    playwright,
  }) => {
    const ctx = await newApiContext(playwright);
    try {
      const user = await signUpViaApi(ctx);
      const org = user.orgSlug;
      const repoConn = await createRepoScopedConnection(ctx, org);
      const volume = `acme-widget-${Date.now()}`;

      // Create — owner/repo come from the connection's repoScope, not input.
      const { config } = await callSelfMcpTool<{ config: SyncConfig }>(
        ctx,
        org,
        "ORG_REPO_SYNC_CREATE",
        { connectionId: repoConn, volume },
      );
      expect(config.repoOwner).toBe("acme");
      expect(config.repoName).toBe("widget");
      expect(config.ref).toBe("main");
      expect(config.enabled).toBe(true);
      expect(config.lastSyncedAt).toBeNull();

      // The volume is now claimed: a second config on it is rejected with a
      // friendly message, not a raw unique-constraint error.
      await expect(
        callSelfMcpTool(ctx, org, "ORG_REPO_SYNC_CREATE", {
          connectionId: repoConn,
          volume,
        }),
      ).rejects.toThrow(/already the target/);

      // Sync-owned volumes are mirrors: direct fs writes are rejected
      // server-side (the next sync would silently delete them).
      const intruder = await ctx.put(
        `/api/${org}/fs/${volume}/file?path=intruder.txt`,
        { data: "x", headers: { "Content-Type": "text/plain" } },
      );
      expect(intruder.status()).toBe(403);

      // List surfaces it.
      const listed = await callSelfMcpTool<{ configs: SyncConfig[] }>(
        ctx,
        org,
        "ORG_REPO_SYNC_LIST",
        {},
      );
      expect(listed.configs.map((c) => c.id)).toContain(config.id);

      // Run: the fixture connection cannot mint a real installation token, so
      // the sync fails — folded into the result and recorded on the config,
      // never thrown.
      const { result } = await callSelfMcpTool<{
        result: { id: string; volume: string; error?: string };
      }>(ctx, org, "ORG_REPO_SYNC_RUN", { id: config.id });
      expect(result.id).toBe(config.id);
      expect(result.error).toBeTruthy();

      const afterRun = await callSelfMcpTool<{ configs: SyncConfig[] }>(
        ctx,
        org,
        "ORG_REPO_SYNC_LIST",
        {},
      );
      const ran = afterRun.configs.find((c) => c.id === config.id);
      expect(ran?.lastSyncedAt).not.toBeNull();
      expect(ran?.lastSyncError).toBeTruthy();

      // Update: ref + enabled are mutable; the volume is not in the schema.
      const updated = await callSelfMcpTool<{ config: SyncConfig }>(
        ctx,
        org,
        "ORG_REPO_SYNC_UPDATE",
        { id: config.id, ref: "develop", enabled: false },
      );
      expect(updated.config.ref).toBe("develop");
      expect(updated.config.enabled).toBe(false);

      // A disabled sync refuses on-demand runs (running would still mirror
      // and delete files the user assumed safe after pausing).
      await expect(
        callSelfMcpTool(ctx, org, "ORG_REPO_SYNC_RUN", { id: config.id }),
      ).rejects.toThrow(/disabled/);

      // Delete removes the config (files, if any, are left alone).
      const del = await callSelfMcpTool<{ deleted: boolean }>(
        ctx,
        org,
        "ORG_REPO_SYNC_DELETE",
        { id: config.id },
      );
      expect(del.deleted).toBe(true);
      const finalList = await callSelfMcpTool<{ configs: SyncConfig[] }>(
        ctx,
        org,
        "ORG_REPO_SYNC_LIST",
        {},
      );
      expect(finalList.configs.map((c) => c.id)).not.toContain(config.id);
    } finally {
      await ctx.dispose();
    }
  });
});
