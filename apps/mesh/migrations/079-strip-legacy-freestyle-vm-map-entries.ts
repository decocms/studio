/**
 * Scrub legacy vmMap entries with retired runnerKinds.
 *
 * PR #3411 (`refactor(sandbox): remove freestyle runner`) narrowed
 * `RunnerKind` from `"host" | "docker" | "agent-sandbox" | "freestyle"` to
 * `"host" | "docker" | "agent-sandbox"` and tightened the `VmMapEntrySchema`
 * accordingly. VMs started before the cutover left
 * `connections.metadata.vmMap[userId][branch].runnerKind = "freestyle"`
 * rows in the DB. `COLLECTION_VIRTUAL_MCP_LIST` validates its output
 * against the new schema, so those rows now make the whole list call
 * fail with `MCP error -32602: Output validation error`.
 *
 * The freestyle runner is gone, so the freestyle entries can never be
 * resumed or torn down — match PR #3411's "skip teardown" intent by
 * deleting them. User buckets that become empty are dropped too, since
 * `readVmMap` treats a missing user the same as an empty one.
 *
 * Defined-by-omission entries (no `runnerKind` field at all) are left
 * alone: the schema accepts them via `.optional()`.
 */
import { type Kysely, sql } from "kysely";

const VALID_RUNNER_KINDS = new Set(["host", "docker", "agent-sandbox"]);

type VmEntry = { runnerKind?: unknown } & Record<string, unknown>;
type UserMap = Record<string, VmEntry>;
type VmMap = Record<string, UserMap>;

export async function up(db: Kysely<unknown>): Promise<void> {
  const result = await sql<{ id: string; metadata: string | null }>`
    SELECT id, metadata FROM "connections"
    WHERE connection_type = 'VIRTUAL'
      AND metadata IS NOT NULL
      AND metadata LIKE '%vmMap%'
  `.execute(db);

  for (const row of result.rows) {
    if (!row.metadata) continue;

    let meta: Record<string, unknown>;
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      continue;
    }

    const vmMap = meta.vmMap;
    if (!vmMap || typeof vmMap !== "object") continue;

    let changed = false;
    const nextVmMap: VmMap = {};

    for (const [userId, userMap] of Object.entries(vmMap as VmMap)) {
      if (!userMap || typeof userMap !== "object") {
        changed = true;
        continue;
      }

      const nextUserMap: UserMap = {};
      for (const [branch, entry] of Object.entries(userMap)) {
        if (!entry || typeof entry !== "object") {
          changed = true;
          continue;
        }
        const kind = (entry as VmEntry).runnerKind;
        if (kind !== undefined && !VALID_RUNNER_KINDS.has(kind as string)) {
          changed = true;
          continue;
        }
        nextUserMap[branch] = entry;
      }

      if (Object.keys(nextUserMap).length > 0) {
        nextVmMap[userId] = nextUserMap;
      } else {
        changed = true;
      }
    }

    if (!changed) continue;

    meta.vmMap = nextVmMap;
    const updated = JSON.stringify(meta);

    await sql`
      UPDATE "connections"
      SET metadata = ${updated}
      WHERE id = ${row.id}
    `.execute(db);
  }
}

export async function down(_db: Kysely<unknown>): Promise<void> {
  // No-op: the deleted entries pointed at a runner that no longer exists,
  // so there is nothing meaningful to restore.
}
