/**
 * Machine surface for the sandbox controller. One endpoint: re-mint a clone
 * credential, which needs studio's DB + vault and so cannot move out.
 *
 * Deliberately NOT under `/api/_admin` — that prefix is the human
 * deployment-admin surface, with impersonation and audit semantics. A machine
 * peer on a different auth model gets its own namespace and its own credential.
 */

import { timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { sql, type Kysely } from "kysely";
import {
  cloneUrlRequestSchema,
  type CloneUrlResponse,
} from "@decocms/sandbox/provider/remote/protocol";
// Subpath, not the barrel: the barrel drags in @kubernetes/client-node.
import {
  parseTenantPools,
  repoKeyFromCloneUrl,
} from "@decocms/sandbox/provider/agent-sandbox/tenant-pools";
import { getDb } from "@/database";
import { CredentialVault } from "@/encryption/credential-vault";
import { buildCloneInfo } from "@/shared/github-clone-info";
import { parseGithubOwnerRepo } from "@/sandbox/parse-github-clone-url";
import { getSettings } from "@/settings";
import type { Database } from "@/storage/types";

export const SANDBOX_CONTROLLER_API_PREFIX = "/api/_sandbox-controller";

/**
 * The bearer this endpoint requires. Unset means the endpoint refuses to serve
 * — see the route below. `SANDBOX_CONTROLLER_INSECURE=1` opts local dev out.
 */
function controllerToken(): string | undefined {
  return process.env.SANDBOX_CONTROLLER_TOKEN?.trim() || undefined;
}

function bearerMatches(header: string, expected: string): boolean {
  if (!header.startsWith("Bearer ")) return false;
  const presented = Buffer.from(header.slice(7));
  const want = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  return presented.length === want.length && timingSafeEqual(presented, want);
}

/**
 * Is `(connectionId, repoKey)` a pair some live sandbox — or some configured
 * warm pool — is already using?
 *
 * This is the whole security of the endpoint. `buildCloneInfo` carries no org
 * scope (correctly: its other caller is in-process and already scoped), so
 * without this check a caller naming an arbitrary connection would mint a live
 * GitHub App token for ANY connection in the deployment, across orgs. With it,
 * the endpoint only refreshes credentials the caller could already read off a
 * persisted clone URL.
 *
 * The SCOPE check, not the authn one — the bearer above keeps strangers out.
 *
 * ponytail: unindexed jsonb seq scan, once per sandbox per ~50min. Add an index
 * on `(state->'ensureOpts'->'repo'->>'connectionId')` if that stops being cheap.
 */
async function isRecordedRepo(
  db: Kysely<Database>,
  connectionId: string,
  repoKey: string,
): Promise<boolean> {
  const rows = await db
    .selectFrom("sandbox_runner_state")
    .select("state")
    .where(
      sql<string>`state -> 'ensureOpts' -> 'repo' ->> 'connectionId'`,
      "=",
      connectionId,
    )
    .execute();
  for (const row of rows) {
    const repo = (
      row.state as {
        ensureOpts?: { repo?: { cloneUrl?: string; connectionId?: string } };
      }
    )?.ensureOpts?.repo;
    if (!repo?.cloneUrl) continue;
    if (repoKeyFromCloneUrl(repo.cloneUrl) === repoKey) return true;
  }
  // Warm-pool pods have no state row; their pair lives in the shared deploy env.
  return parseTenantPools(process.env.STUDIO_SANDBOX_TENANT_POOLS).some(
    (pool) =>
      pool.connectionId === connectionId && pool.repo.toLowerCase() === repoKey,
  );
}

export function createSandboxControllerRoutes() {
  const app = new Hono();

  app.post("/clone-url", async (c) => {
    // Fails closed: this mints live GitHub App tokens on the public API.
    const expected = controllerToken();
    if (!expected) {
      if (process.env.SANDBOX_CONTROLLER_INSECURE !== "1") {
        return c.json(
          { error: "sandbox controller callback not configured" },
          503,
        );
      }
    } else if (!bearerMatches(c.req.header("authorization") ?? "", expected)) {
      return c.json({ error: "unauthorized" }, 401);
    }

    const parsed = cloneUrlRequestSchema.safeParse(await c.req.json());
    if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
    const { connectionId, cloneUrl, bufferMs } = parsed.data;

    const owned = parseGithubOwnerRepo(cloneUrl);
    const repoKey = repoKeyFromCloneUrl(cloneUrl);
    if (!owned || !repoKey)
      return c.json({ error: "unparseable clone url" }, 400);

    const { db } = getDb();
    if (!(await isRecordedRepo(db, connectionId, repoKey))) {
      return c.json({ error: "no sandbox uses that repo/connection" }, 403);
    }

    const vault = new CredentialVault(getSettings().encryptionKey);
    const { cloneUrl: fresh } = await buildCloneInfo(
      connectionId,
      owned.owner,
      owned.name,
      db,
      vault,
      bufferMs !== undefined ? { bufferMs } : undefined,
    );
    return c.json({ cloneUrl: fresh } satisfies CloneUrlResponse);
  });

  return app;
}
