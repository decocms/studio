/**
 * Migration 104: canonicalize the hosted sandbox provider kind.
 *
 * `agent-sandbox` is the persisted provider kind for Studio-hosted sandboxes.
 * Earlier storage used the legacy `cluster` spelling. This migration rewrites
 * the persisted discriminants while keeping compatibility parsing in runtime
 * code responsible for any old external inputs.
 */

import { sql, type Kysely } from "kysely";

type BranchMap = Record<string, unknown>;
type UserMap = Record<string, BranchMap>;
type SandboxMap = Record<string, UserMap>;

const LEGACY_KIND = "cluster";
const CANONICAL_KIND = "agent-sandbox";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRecord(
  value: unknown,
  fromKind: string,
  toKind: string,
): unknown {
  if (!isRecord(value)) return value;
  if (value.sandboxProviderKind !== fromKind) return value;
  return { ...value, sandboxProviderKind: toKind };
}

function isValidSandboxRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (typeof value.sandboxHandle !== "string") return false;
  if (value.previewUrl !== null && typeof value.previewUrl !== "string") {
    return false;
  }
  if (
    value.sandboxApiUrl !== undefined &&
    value.sandboxApiUrl !== null &&
    typeof value.sandboxApiUrl !== "string"
  ) {
    return false;
  }
  if (
    value.sandboxProviderKind !== undefined &&
    value.sandboxProviderKind !== LEGACY_KIND &&
    value.sandboxProviderKind !== CANONICAL_KIND &&
    value.sandboxProviderKind !== "user-desktop"
  ) {
    return false;
  }
  if (value.createdAt !== undefined && typeof value.createdAt !== "number") {
    return false;
  }
  if (value.startedWith !== undefined) {
    if (!isRecord(value.startedWith)) return false;
    for (const key of ["packageManager", "port", "path"]) {
      const nested = value.startedWith[key];
      if (
        nested !== undefined &&
        nested !== null &&
        typeof nested !== "string"
      ) {
        return false;
      }
    }
  }
  return true;
}

function rewriteSandboxMap(
  sandboxMap: unknown,
  fromKind: string,
  toKind: string,
): { sandboxMap: SandboxMap; changed: boolean } | null {
  if (!isRecord(sandboxMap)) return null;

  let changed = false;
  const nextSandboxMap: SandboxMap = {};

  for (const [userId, userMap] of Object.entries(sandboxMap)) {
    if (!isRecord(userMap)) {
      nextSandboxMap[userId] = userMap as UserMap;
      continue;
    }

    const nextUserMap: UserMap = {};
    for (const [branch, branchMap] of Object.entries(userMap)) {
      if (!isRecord(branchMap)) {
        nextUserMap[branch] = branchMap as BranchMap;
        continue;
      }

      const nextBranchMap: BranchMap = {};
      for (const [kind, entry] of Object.entries(branchMap)) {
        if (kind === fromKind) {
          changed = true;
          if (!(toKind in branchMap)) {
            nextBranchMap[toKind] = normalizeRecord(entry, fromKind, toKind);
          } else if (
            !isValidSandboxRecord(branchMap[toKind]) &&
            isValidSandboxRecord(entry)
          ) {
            nextBranchMap[toKind] = normalizeRecord(entry, fromKind, toKind);
          }
          continue;
        }

        const nextEntry = normalizeRecord(entry, fromKind, toKind);
        if (nextEntry !== entry) changed = true;
        if (
          kind === toKind &&
          kind in nextBranchMap &&
          isValidSandboxRecord(nextBranchMap[kind]) &&
          !isValidSandboxRecord(nextEntry)
        ) {
          continue;
        }
        nextBranchMap[kind] = nextEntry;
      }

      nextUserMap[branch] = nextBranchMap;
    }

    nextSandboxMap[userId] = nextUserMap;
  }

  return { sandboxMap: nextSandboxMap, changed };
}

async function rewriteConnectionMetadata(
  db: Kysely<unknown>,
  fromKind: string,
  toKind: string,
): Promise<void> {
  const result = await sql<{ id: string; metadata: string | null }>`
    SELECT id, metadata FROM connections
    WHERE connection_type = 'VIRTUAL'
      AND metadata IS NOT NULL
      AND metadata LIKE ${"%" + fromKind + "%"}
  `.execute(db);

  for (const row of result.rows) {
    if (!row.metadata) continue;

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      continue;
    }

    const rewrite = rewriteSandboxMap(meta.sandboxMap, fromKind, toKind);
    if (!rewrite?.changed) continue;

    meta.sandboxMap = rewrite.sandboxMap;
    await sql`
      UPDATE connections
      SET metadata = ${JSON.stringify(meta)}
      WHERE id = ${row.id}
    `.execute(db);
  }
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE threads
    SET sandbox_provider_kind = ${CANONICAL_KIND}
    WHERE sandbox_provider_kind = ${LEGACY_KIND}
  `.execute(db);

  await sql`
    UPDATE sandbox_runner_state canonical
    SET handle = legacy.handle,
        state = legacy.state,
        updated_at = legacy.updated_at
    FROM sandbox_runner_state legacy
    WHERE canonical.sandbox_provider_kind = ${CANONICAL_KIND}
      AND legacy.sandbox_provider_kind = ${LEGACY_KIND}
      AND canonical.user_id = legacy.user_id
      AND canonical.project_ref = legacy.project_ref
      AND legacy.updated_at > canonical.updated_at
  `.execute(db);

  await sql`
    DELETE FROM sandbox_runner_state legacy
    WHERE legacy.sandbox_provider_kind = ${LEGACY_KIND}
      AND EXISTS (
        SELECT 1
        FROM sandbox_runner_state canonical
        WHERE canonical.user_id = legacy.user_id
          AND canonical.project_ref = legacy.project_ref
          AND canonical.sandbox_provider_kind = ${CANONICAL_KIND}
      )
  `.execute(db);

  await sql`
    UPDATE sandbox_runner_state
    SET sandbox_provider_kind = ${CANONICAL_KIND}
    WHERE sandbox_provider_kind = ${LEGACY_KIND}
  `.execute(db);

  await rewriteConnectionMetadata(db, LEGACY_KIND, CANONICAL_KIND);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE threads
    SET sandbox_provider_kind = ${LEGACY_KIND}
    WHERE sandbox_provider_kind = ${CANONICAL_KIND}
  `.execute(db);

  await sql`
    UPDATE sandbox_runner_state legacy
    SET handle = canonical.handle,
        state = canonical.state,
        updated_at = canonical.updated_at
    FROM sandbox_runner_state canonical
    WHERE legacy.sandbox_provider_kind = ${LEGACY_KIND}
      AND canonical.sandbox_provider_kind = ${CANONICAL_KIND}
      AND legacy.user_id = canonical.user_id
      AND legacy.project_ref = canonical.project_ref
      AND canonical.updated_at > legacy.updated_at
  `.execute(db);

  await sql`
    DELETE FROM sandbox_runner_state canonical
    WHERE canonical.sandbox_provider_kind = ${CANONICAL_KIND}
      AND EXISTS (
        SELECT 1
        FROM sandbox_runner_state legacy
        WHERE legacy.user_id = canonical.user_id
          AND legacy.project_ref = canonical.project_ref
          AND legacy.sandbox_provider_kind = ${LEGACY_KIND}
      )
  `.execute(db);

  await sql`
    UPDATE sandbox_runner_state
    SET sandbox_provider_kind = ${LEGACY_KIND}
    WHERE sandbox_provider_kind = ${CANONICAL_KIND}
  `.execute(db);

  await rewriteConnectionMetadata(db, CANONICAL_KIND, LEGACY_KIND);
}
