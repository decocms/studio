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
 * for its in-process callers), so before minting, each route checks the
 * request against Studio's own records: the tenant's user is a member of its
 * org, and the credential source belongs to that org (or to a configured warm
 * pool). The controller keeps sandbox state in its own database, so the
 * request's tenant is the controller's word; the org scope is what bounds a
 * leaked controller certificate.
 */

import { Hono } from "hono";
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

/** Where a sandbox's primary clone credential is minted from. */
export type CloneCredentialSource =
  | { connectionId: string }
  | { repositoryId: string };

/** A tenant as Studio records it. */
export interface RecordedTenant {
  orgId: string;
  userId: string;
  orgSlug: string;
}

export interface SandboxControllerCallbackDeps {
  /** The tenant, when `userId` is a member of `orgId`; null otherwise. */
  recordedTenant(tenant: {
    orgId: string;
    userId: string;
  }): Promise<RecordedTenant | null>;
  /** The org a connection or repository belongs to; null when there is none. */
  credentialOrg(source: CloneCredentialSource): Promise<string | null>;
  /** Warm-pool pods have no tenant; their repo is declared in config. */
  tenantPools: readonly TenantPool[];
  mintCloneUrl(
    repo: { cloneUrl: string; connectionId?: string; repositoryId?: string },
    opts: { bufferMs?: number },
  ): Promise<string | null>;
  mintOrgFsConfig(tenant: RecordedTenant): Promise<string | null>;
}

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
    const { connectionId, repositoryId, cloneUrl, tenant, bufferMs } =
      parsed.data;
    if (!cloneUrlIdentity(cloneUrl)) {
      return c.json({ error: "unparseable cloneUrl" }, 400);
    }
    // The mint prefers a repository over a connection, so the check does too.
    const source: CloneCredentialSource = repositoryId
      ? { repositoryId }
      : { connectionId: connectionId ?? "" };
    const inTenantOrg = async () => {
      if (!tenant) return false;
      const [member, org] = await Promise.all([
        deps.recordedTenant(tenant),
        deps.credentialOrg(source),
      ]);
      return member !== null && org === tenant.orgId;
    };
    const poolKey = repoKeyFromCloneUrl(cloneUrl);
    const pooled =
      !repositoryId &&
      poolKey !== null &&
      deps.tenantPools.some(
        (pool) =>
          pool.connectionId === connectionId &&
          pool.repo.toLowerCase() === poolKey,
      );
    if (!pooled && !(await inTenantOrg())) {
      return c.json(
        {
          error:
            "that repository credential belongs to no warm pool and to no org the tenant's user is a member of",
        },
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
    // Minted for the tenant Studio records (its slug included), not the one
    // the request spells out: only the ids are the controller's word.
    const tenant = await deps.recordedTenant(parsed.data.tenant);
    if (!tenant) {
      return c.json(
        { error: "the tenant's user is not a member of its org" },
        403,
      );
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
