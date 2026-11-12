import { type Kysely, sql } from "kysely";
import type { Database, DecofilePendingBlock } from "./types";

/** The branch a set of pending blocks belongs to. */
export interface PendingBranchScope {
  organizationId: string;
  virtualMcpId: string;
  branch: string;
}

function toBlock(row: {
  block_key: string;
  content: string | null;
  revision: string;
}): DecofilePendingBlock {
  return {
    blockKey: row.block_key,
    content:
      row.content === null
        ? null
        : (JSON.parse(row.content) as Record<string, unknown>),
    revision: String(row.revision),
  };
}

/** Fast Preview saves held in Studio instead of committed (migration 264). */
export class DecofilePendingBlockStorage {
  constructor(private readonly db: Kysely<Database>) {}

  async list(scope: PendingBranchScope): Promise<DecofilePendingBlock[]> {
    const rows = await this.db
      .selectFrom("decofile_pending_blocks")
      .select(["block_key", "content", "revision"])
      .where("organization_id", "=", scope.organizationId)
      .where("virtual_mcp_id", "=", scope.virtualMcpId)
      .where("branch", "=", scope.branch)
      .orderBy("block_key")
      .execute();
    return rows.map(toBlock);
  }

  /**
   * Store a patch. `check` runs first, inside the same transaction and under a
   * per-branch lock, with the branch's current pending rows; throwing from it
   * writes nothing. Concurrent writes to one branch are serialized, so a check
   * never passes against a row another write is replacing.
   */
  async write(
    scope: PendingBranchScope,
    patch: { set: Record<string, unknown>; delete: string[] },
    updatedBy: string | null,
    check: (current: Map<string, DecofilePendingBlock>) => Promise<void>,
  ): Promise<void> {
    await this.db.transaction().execute(async (tx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`decofile-pending:${scope.organizationId}:${scope.virtualMcpId}:${scope.branch}`}, 0))`.execute(
        tx,
      );
      const rows = await tx
        .selectFrom("decofile_pending_blocks")
        .select(["block_key", "content", "revision"])
        .where("organization_id", "=", scope.organizationId)
        .where("virtual_mcp_id", "=", scope.virtualMcpId)
        .where("branch", "=", scope.branch)
        .execute();
      await check(new Map(rows.map((r) => [r.block_key, toBlock(r)])));

      const values = [
        ...Object.entries(patch.set).map(([key, value]) => ({
          key,
          content: JSON.stringify(value),
        })),
        ...patch.delete.map((key) => ({ key, content: null })),
      ];
      if (values.length === 0) return;
      await tx
        .insertInto("decofile_pending_blocks")
        .values(
          values.map(({ key, content }) => ({
            organization_id: scope.organizationId,
            virtual_mcp_id: scope.virtualMcpId,
            branch: scope.branch,
            block_key: key,
            content,
            updated_by: updatedBy,
          })),
        )
        .onConflict((oc) =>
          oc
            .columns([
              "organization_id",
              "virtual_mcp_id",
              "branch",
              "block_key",
            ])
            .doUpdateSet({
              content: (eb) => eb.ref("excluded.content"),
              updated_by: (eb) => eb.ref("excluded.updated_by"),
              revision: sql`nextval('decofile_pending_blocks_revision_seq')`,
              updated_at: sql`now()`,
            }),
        )
        .execute();
    });
  }

  /**
   * Delete the given rows, each only while it still holds the revision that
   * was read: a block saved again meanwhile stays pending.
   */
  async deleteRevisions(
    scope: PendingBranchScope,
    blocks: Array<Pick<DecofilePendingBlock, "blockKey" | "revision">>,
  ): Promise<void> {
    if (blocks.length === 0) return;
    await this.db
      .deleteFrom("decofile_pending_blocks")
      .where("organization_id", "=", scope.organizationId)
      .where("virtual_mcp_id", "=", scope.virtualMcpId)
      .where("branch", "=", scope.branch)
      .where((eb) =>
        eb.or(
          blocks.map((b) =>
            eb.and([
              eb("block_key", "=", b.blockKey),
              eb("revision", "=", sql<string>`${b.revision}::bigint`),
            ]),
          ),
        ),
      )
      .execute();
  }

  /** Drop the pending saves of these blocks, whatever their revision. */
  async deleteKeys(scope: PendingBranchScope, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db
      .deleteFrom("decofile_pending_blocks")
      .where("organization_id", "=", scope.organizationId)
      .where("virtual_mcp_id", "=", scope.virtualMcpId)
      .where("branch", "=", scope.branch)
      .where("block_key", "in", keys)
      .execute();
  }
}
