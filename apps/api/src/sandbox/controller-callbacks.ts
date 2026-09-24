/**
 * The sandbox controller's callbacks into Studio: re-mint a clone credential
 * or an org-fs mount config, both of which need Studio's database and vault.
 *
 * Served only on a dedicated mTLS listener, never on the public app. The
 * public listener sits behind nginx and a TLS-terminating load balancer, so a
 * request there carries no client certificate to authorize. Here Bun completes
 * the handshake only for a certificate that chains to the controller CA, and
 * that CA is dedicated to the installation's Studio/controller pair: holding a
 * certificate it signed is the controller's identity.
 *
 * Authorization is not scope. `buildCloneInfo` has no org check (correctly,
 * for its in-process callers), so before minting, each route verifies the
 * request names something a live sandbox already has. Without that, the
 * controller's certificate would mint a token for any connection in the
 * deployment.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  CloneURLPath,
  cloneUrlRequestSchema,
  OrgFsConfigPath,
  orgFsConfigRequestSchema,
} from "@decocms/sandbox/provider/remote";
import {
  repoKeyFromCloneUrl,
  type TenantPool,
} from "@decocms/sandbox/provider/tenant-pools";
import type { CloneCredentialSource } from "@/storage/sandbox-runner-state";

export interface SandboxControllerCallbackDeps {
  statesByCloneSource(source: CloneCredentialSource): Promise<unknown[]>;
  statesByTenant(tenant: { orgId: string; userId: string }): Promise<unknown[]>;
  /** Warm-pool pods have no state row; their repo is declared in config. */
  tenantPools: readonly TenantPool[];
  mintCloneUrl(
    repo: { cloneUrl: string; connectionId?: string; repositoryId?: string },
    opts: { bufferMs?: number },
  ): Promise<string | null>;
  mintOrgFsConfig(tenant: {
    orgId: string;
    userId: string;
    orgSlug?: string;
  }): Promise<string | null>;
}

const persistedRepoSchema = z.object({
  ensureOpts: z.object({
    repo: z.object({
      cloneUrl: z.string(),
      connectionId: z.string().optional(),
      repositoryId: z.string().optional(),
    }),
  }),
});

const persistedTenantSchema = z.object({
  tenant: z.object({
    orgId: z.string(),
    userId: z.string(),
    orgSlug: z.string().optional(),
  }),
  ensureOpts: z.object({ orgFsConfigJson: z.string().min(1) }),
});

/**
 * The repository a clone URL points at, credential and `.git` aside, so a
 * re-minted URL still matches the one a sandbox was provisioned with.
 */
export function cloneUrlIdentity(cloneUrl: string): string | null {
  if (!URL.canParse(cloneUrl)) return null;
  const url = new URL(cloneUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
  return path ? `${url.hostname.toLowerCase()}${path}` : null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createSandboxControllerCallbackApp(
  deps: SandboxControllerCallbackDeps,
) {
  const app = new Hono();

  app.post(CloneURLPath, async (c) => {
    const parsed = cloneUrlRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const { connectionId, repositoryId, cloneUrl, bufferMs } = parsed.data;
    const identity = cloneUrlIdentity(cloneUrl);
    if (!identity) return c.json({ error: "unparseable cloneUrl" }, 400);

    // Verified against the same source the mint uses: a repository wins over
    // a connection there, so it wins here.
    const source: CloneCredentialSource = repositoryId
      ? { repositoryId }
      : { connectionId: connectionId ?? "" };
    const states = await deps.statesByCloneSource(source);
    const recorded = states.some((state) => {
      const row = persistedRepoSchema.safeParse(state);
      if (!row.success) return false;
      const repo = row.data.ensureOpts.repo;
      const sameSource = repositoryId
        ? repo.repositoryId === repositoryId
        : repo.connectionId === connectionId;
      return sameSource && cloneUrlIdentity(repo.cloneUrl) === identity;
    });
    const poolKey = repoKeyFromCloneUrl(cloneUrl);
    const pooled =
      !repositoryId &&
      poolKey !== null &&
      deps.tenantPools.some(
        (pool) =>
          pool.connectionId === connectionId &&
          pool.repo.toLowerCase() === poolKey,
      );
    if (!recorded && !pooled) {
      return c.json(
        { error: "no sandbox or warm pool uses that repository credential" },
        403,
      );
    }

    try {
      const fresh = await deps.mintCloneUrl(
        { cloneUrl, connectionId, repositoryId },
        { bufferMs },
      );
      return c.json({ cloneUrl: fresh });
    } catch (err) {
      // The controller keeps the URL it has, as the in-process runner does.
      console.warn(
        `[sandbox-controller] clone-url mint failed: ${errMsg(err)}`,
      );
      return c.json({ cloneUrl: null });
    }
  });

  app.post(OrgFsConfigPath, async (c) => {
    const parsed = orgFsConfigRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) {
      return c.json({ error: parsed.error.message }, 400);
    }
    const { orgId, userId } = parsed.data.tenant;
    const states = await deps.statesByTenant({ orgId, userId });
    // The key is minted for the tenant the sandbox was provisioned for, not
    // the one the request spells out: only the ids are trusted to match.
    const tenant = states.flatMap((state) => {
      const row = persistedTenantSchema.safeParse(state);
      return row.success &&
        row.data.tenant.orgId === orgId &&
        row.data.tenant.userId === userId
        ? [row.data.tenant]
        : [];
    })[0];
    if (!tenant) {
      return c.json({ error: "no sandbox mounts org-fs for that tenant" }, 403);
    }

    try {
      return c.json({ orgFsConfigJson: await deps.mintOrgFsConfig(tenant) });
    } catch (err) {
      console.warn(
        `[sandbox-controller] org-fs config mint failed: ${errMsg(err)}`,
      );
      return c.json({ orgFsConfigJson: null });
    }
  });

  return app;
}

export interface CallbackListenerTls {
  cert: string;
  key: string;
  /** The controller CA. Only certificates it signs complete a handshake. */
  ca: string;
}

/**
 * Both API containers of a pod serve it on one port: `reusePort` lets the
 * kernel split connections between them.
 */
export function serveSandboxControllerCallbacks(opts: {
  port: number;
  hostname?: string;
  tls: CallbackListenerTls;
  app: { fetch: (request: Request) => Response | Promise<Response> };
}) {
  return Bun.serve({
    port: opts.port,
    hostname: opts.hostname ?? "0.0.0.0",
    reusePort: true,
    tls: {
      cert: opts.tls.cert,
      key: opts.tls.key,
      ca: opts.tls.ca,
      requestCert: true,
      rejectUnauthorized: true,
    },
    fetch: (request) => opts.app.fetch(request),
    development: false,
  });
}
