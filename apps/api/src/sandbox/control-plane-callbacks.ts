/**
 * The control plane's callbacks into Studio: re-mint a clone credential or an
 * org-fs mount config, both of which need Studio's database and vault.
 *
 * The bearer proves the caller is this Studio's control plane. It is not
 * scope: `buildCloneInfo` has no org check. Scope is the callback grant
 * Studio signed into the sandbox's ensure options (`callback-grant.ts`): a
 * request mints only for the tenant and repos its grant names, and only while
 * Studio's records still agree — the user is a member of the org and the
 * credential belongs to it. Tenant-pool pods have no tenant and no grant;
 * Studio's own pool config vouches for them.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import type { Kysely } from "kysely";
import {
  parseTenantPools,
  repoKeyFromCloneUrl,
  type TenantPool,
} from "@decocms/sandbox/provider/agent-sandbox";
import {
  cloneUrlRequestSchema,
  orgFsConfigRequestSchema,
  SANDBOX_CALLBACK_PATHS,
} from "@decocms/sandbox/provider/sandbox-api";
import { CredentialVault } from "@/encryption/credential-vault";
import {
  type CallbackGrantScope,
  grantCoversRepo,
  verifyCallbackGrant,
} from "@/sandbox/callback-grant";
import { getDb } from "@/database";
import { getSettings } from "@/settings";
import { sandboxCredentialMinters } from "@/sandbox/credential-mint";
import { readControlPlaneSandboxConfig } from "@/sandbox/lifecycle";
import type { Database as DatabaseSchema } from "@/storage/types";

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

export interface SandboxCallbackDeps {
  token: string;
  /** Verify callback grants; the first also signs them. */
  grantSecrets: readonly string[];
  /** The tenant, when `userId` is a member of `orgId`; null otherwise. */
  recordedTenant(tenant: {
    orgId: string;
    userId: string;
  }): Promise<RecordedTenant | null>;
  /** The org a connection or repository belongs to; null when there is none. */
  credentialOrg(source: CloneCredentialSource): Promise<string | null>;
  /** Pool pods have no tenant; their repo is declared in config. */
  tenantPools: readonly TenantPool[];
  mintCloneUrl(
    repo: { cloneUrl: string; connectionId?: string; repositoryId?: string },
    opts: { bufferMs?: number },
  ): Promise<string | null>;
  mintOrgFsConfig(tenant: RecordedTenant): Promise<string | null>;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bearerMatches(c: Context, token: string): boolean {
  const header = c.req.header("authorization") ?? "";
  const presented = Buffer.from(header.replace(/^Bearer\s+/i, ""));
  const expected = Buffer.from(token);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

/** The grant's scope when it verifies and names the tenant the request does. */
function grantedScope(
  deps: SandboxCallbackDeps,
  grant: string | undefined,
  tenant: { orgId: string; userId: string } | undefined,
): CallbackGrantScope | null {
  if (!grant) return null;
  const scope = verifyCallbackGrant(grant, deps.grantSecrets);
  if (!scope) return null;
  if (
    tenant &&
    (tenant.orgId !== scope.orgId || tenant.userId !== scope.userId)
  )
    return null;
  return scope;
}

export function createSandboxCallbackApp(deps: SandboxCallbackDeps) {
  const app = new Hono();

  app.post(SANDBOX_CALLBACK_PATHS.cloneUrl, async (c) => {
    if (!bearerMatches(c, deps.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const parsed = cloneUrlRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { connectionId, repositoryId, cloneUrl, tenant, bufferMs, grant } =
      parsed.data;
    // The mint prefers a repository over a connection, so the check does too.
    const source: CloneCredentialSource = repositoryId
      ? { repositoryId }
      : { connectionId: connectionId ?? "" };
    const poolKey = repoKeyFromCloneUrl(cloneUrl);
    const pooled =
      !repositoryId &&
      poolKey !== null &&
      deps.tenantPools.some(
        (pool) =>
          pool.connectionId === connectionId &&
          pool.repo.toLowerCase() === poolKey,
      );
    const granted = async () => {
      const scope = grantedScope(deps, grant, tenant);
      if (!scope || !grantCoversRepo(scope, parsed.data)) return false;
      const [member, org] = await Promise.all([
        deps.recordedTenant(scope),
        deps.credentialOrg(source),
      ]);
      return member !== null && org === scope.orgId;
    };
    if (!pooled && !(await granted())) {
      if (!tenant && !grant && !repositoryId) {
        // Studio's pool config and the host's are separate settings; a pool
        // the host runs that Studio does not list lands here on every mint.
        console.warn(
          `[sandbox-callbacks] refused a pool clone-url mint for ${poolKey ?? "an unrecognized repo"} (connection ${connectionId ?? "none"}): no pool in STUDIO_SANDBOX_TENANT_POOLS matches. Configure the same pools as the control plane's SANDBOX_TENANT_POOLS.`,
        );
      }
      return c.json(
        {
          error:
            "that credential belongs to no tenant pool and to no repo this sandbox's grant covers",
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
      // The runner keeps the URL it has.
      console.warn(`[sandbox-callbacks] clone-url mint failed: ${errMsg(err)}`);
      return c.json({ cloneUrl: null });
    }
  });

  app.post(SANDBOX_CALLBACK_PATHS.orgFsConfig, async (c) => {
    if (!bearerMatches(c, deps.token)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const parsed = orgFsConfigRequestSchema.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const scope = grantedScope(deps, parsed.data.grant, parsed.data.tenant);
    if (!scope) {
      return c.json({ error: "no callback grant for that tenant" }, 403);
    }
    // Minted for the tenant Studio records, slug included.
    const tenant = await deps.recordedTenant(scope);
    if (!tenant) {
      return c.json(
        { error: "the tenant's user is not a member of its org" },
        403,
      );
    }
    // A new 7-day key each time: Better Auth keeps only key hashes, so an
    // earlier key cannot be handed out again. Hosts call this only when they
    // replay a sandbox's persisted options (pod recreated, claim resurrected),
    // which is once per recovery, as the in-process runner does.
    try {
      return c.json({ orgFsConfigJson: await deps.mintOrgFsConfig(tenant) });
    } catch (err) {
      console.warn(
        `[sandbox-callbacks] org-fs config mint failed: ${errMsg(err)}`,
      );
      return c.json({ orgFsConfigJson: null });
    }
  });

  return app;
}

function dbDeps(db: Kysely<DatabaseSchema>) {
  return {
    recordedTenant: async ({
      orgId,
      userId,
    }: {
      orgId: string;
      userId: string;
    }): Promise<RecordedTenant | null> => {
      const row = await db
        .selectFrom("member")
        .innerJoin("organization", "organization.id", "member.organizationId")
        .select("organization.slug")
        .where("member.organizationId", "=", orgId)
        .where("member.userId", "=", userId)
        .executeTakeFirst();
      return row ? { orgId, userId, orgSlug: row.slug } : null;
    },
    credentialOrg: async (
      source: CloneCredentialSource,
    ): Promise<string | null> => {
      const row =
        "repositoryId" in source
          ? await db
              .selectFrom("repositories")
              .select("organization_id")
              .where("id", "=", source.repositoryId)
              .executeTakeFirst()
          : await db
              .selectFrom("connections")
              .select("organization_id")
              .where("id", "=", source.connectionId)
              .executeTakeFirst();
      return row?.organization_id ?? null;
    },
  };
}

/** The routes, when a control plane is configured; otherwise an empty app. */
export function sandboxCallbackRoutes() {
  const controlPlane = readControlPlaneSandboxConfig();
  if (!controlPlane) return new Hono();
  const { db } = getDb();
  const minters = sandboxCredentialMinters(
    db,
    new CredentialVault(getSettings().encryptionKey),
  );
  return createSandboxCallbackApp({
    token: controlPlane.token,
    grantSecrets: controlPlane.grantSecrets,
    ...dbDeps(db),
    tenantPools: parseTenantPools(process.env.STUDIO_SANDBOX_TENANT_POOLS),
    mintCloneUrl: minters.mintCloneUrl,
    mintOrgFsConfig: minters.mintOrgFsConfig,
  });
}
