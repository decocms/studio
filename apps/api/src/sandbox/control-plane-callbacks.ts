/**
 * The control plane's callbacks into Studio: re-mint a clone credential or an
 * org-fs mount config, both of which need Studio's database and vault.
 *
 * The bearer proves the caller is this Studio's control plane. It is not
 * scope: `buildCloneInfo` has no org check, so before minting each route
 * checks the request against Studio's own records — the tenant's user is a
 * member of its org, and the credential belongs to that org (or to a
 * configured tenant pool). That is what bounds a leaked token.
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
    const { connectionId, repositoryId, cloneUrl, tenant, bufferMs } =
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
    const inTenantOrg = async () => {
      if (!tenant) return false;
      const [member, org] = await Promise.all([
        deps.recordedTenant(tenant),
        deps.credentialOrg(source),
      ]);
      return member !== null && org === tenant.orgId;
    };
    if (!pooled && !(await inTenantOrg())) {
      return c.json(
        {
          error:
            "that credential belongs to no tenant pool and to no org the tenant's user is a member of",
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
    // Minted for the tenant Studio records (its slug included): only the ids
    // are the caller's word.
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
    ...dbDeps(db),
    tenantPools: parseTenantPools(process.env.STUDIO_SANDBOX_TENANT_POOLS),
    mintCloneUrl: minters.mintCloneUrl,
    mintOrgFsConfig: minters.mintOrgFsConfig,
  });
}
