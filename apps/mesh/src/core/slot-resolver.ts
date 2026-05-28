/**
 * Slot resolver — translates a typed slot on an agent into a concrete
 * connection_id at runtime, given the invoking user's identity.
 *
 * See: docs/superpowers/specs/2026-05-27-private-connections-design.md
 *      (section "Slot resolution")
 *
 * Resolution rules:
 *   1. Same organization as the agent.
 *   2. Same app_id as the slot.
 *   3. Active connections only.
 *   4. Prefer (access='user' AND created_by=invokerUserId).
 *   5. Fall back to (access='org').
 *   6. Return null when neither matches; callers decide whether to throw
 *      SlotUnresolvedError or propagate null.
 *
 * The resolver is a pure function over the DB + context; no global state.
 * For one agent run, callers should reuse a SlotResolutionCache instance
 * so repeated slot lookups inside the run don't re-hit the DB.
 */

import { sql, type Kysely } from "kysely";
import type { Database } from "../storage/types";

export interface SlotResolveContext {
  organizationId: string;
  invokerUserId: string;
  appId: string;
}

export interface ResolvedSlot {
  connectionId: string;
  access: "user" | "org";
}

export class SlotUnresolvedError extends Error {
  readonly appId: string;
  constructor(appId: string) {
    super(
      `Slot for app_id '${appId}' could not be resolved — the caller has no matching connection.`,
    );
    this.name = "SlotUnresolvedError";
    this.appId = appId;
  }
}

interface ResolvedRow {
  id: string;
  access: "user" | "org";
}

export async function resolveSlot(
  db: Kysely<Database>,
  ctx: SlotResolveContext,
): Promise<ResolvedSlot | null> {
  const result = (await sql<ResolvedRow>`
    SELECT id, access
    FROM connections
    WHERE organization_id = ${ctx.organizationId}
      AND app_id = ${ctx.appId}
      AND status = 'active'
      AND (
        (access = 'user' AND created_by = ${ctx.invokerUserId})
        OR access = 'org'
      )
    ORDER BY (access = 'user') DESC
    LIMIT 1
  `.execute(db)) as unknown as { rows: ResolvedRow[] };

  const row = result.rows[0];
  if (!row) return null;
  return { connectionId: row.id, access: row.access };
}

/**
 * Per-run resolution cache. Reuse one instance for the duration of a
 * single agent run so the same (userId, appId) lookup hits the DB once.
 *
 * Caches null results too — a missing connection won't appear mid-run
 * unless the user creates one, and the cache lifetime is intentionally
 * short (one run), so that race is acceptable.
 */
export class SlotResolutionCache {
  private cache = new Map<string, ResolvedSlot | null>();

  async resolve(
    userId: string,
    appId: string,
    loader: () => Promise<ResolvedSlot | null>,
  ): Promise<ResolvedSlot | null> {
    const key = `${userId}::${appId}`;
    if (this.cache.has(key)) {
      return this.cache.get(key) ?? null;
    }
    const value = await loader();
    this.cache.set(key, value);
    return value;
  }
}
