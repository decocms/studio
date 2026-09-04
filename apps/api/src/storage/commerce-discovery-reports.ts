import { sql, type Kysely } from "kysely";
import type { CredentialVault } from "../encryption/credential-vault";
import { ConnectionStorage } from "./connection";
import type { Database } from "./types";
import { VirtualMCPStorage } from "./virtual";

export interface CommerceDiscoveryReportRunOwnership {
  organizationId: string;
  runId: string;
  siteUrl: string;
  virtualMcpId: string;
}

export interface CommerceDiscoverySetupScope {
  connections: ConnectionStorage;
  virtualMcps: VirtualMCPStorage;
  reports: CommerceDiscoveryReportStorage;
}

/** Persistence and distributed serialization for the singleton org report. */
export class CommerceDiscoveryReportStorage {
  constructor(
    private db: Kysely<Database>,
    private vault: CredentialVault,
  ) {}

  /**
   * Run one setup at a time per organization, across every API replica.
   *
   * A session-level advisory lock deliberately spans the external `/upgrade`
   * request. That keeps the order in which Commerce Discovery revokes/mints
   * tokens identical to the order in which Studio persists the token/site/
   * owner tuple. The callback receives storages bound to the locked database
   * connection, so this remains safe with a single-connection pool.
   */
  async withSetupLock<T>(
    organizationId: string,
    callback: (scope: CommerceDiscoverySetupScope) => Promise<T>,
  ): Promise<T> {
    const lockKey = `commerce-discovery-setup:${organizationId}`;
    return this.db.connection().execute(async (db) => {
      await sql`select pg_advisory_lock(hashtextextended(${lockKey}, 0))`.execute(
        db,
      );
      try {
        return await callback({
          connections: new ConnectionStorage(db, this.vault),
          virtualMcps: new VirtualMCPStorage(db),
          reports: new CommerceDiscoveryReportStorage(db, this.vault),
        });
      } finally {
        await sql`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`.execute(
          db,
        );
      }
    });
  }

  /**
   * Persist a run's owner once. A replay with the same snapshot is idempotent;
   * reusing a run id for a different site or owner is a protocol violation and
   * must never rewrite the original ownership.
   */
  async recordRun(
    ownership: CommerceDiscoveryReportRunOwnership,
  ): Promise<void> {
    const inserted = await this.db
      .insertInto("commerce_discovery_report_runs")
      .values({
        organization_id: ownership.organizationId,
        run_id: ownership.runId,
        site_url: ownership.siteUrl,
        virtual_mcp_id: ownership.virtualMcpId,
      })
      .onConflict((conflict) =>
        conflict.columns(["organization_id", "run_id"]).doNothing(),
      )
      .returning(["site_url", "virtual_mcp_id"])
      .executeTakeFirst();
    if (inserted) return;

    const existing = await this.findRun(
      ownership.organizationId,
      ownership.runId,
    );
    if (
      !existing ||
      existing.siteUrl !== ownership.siteUrl ||
      existing.virtualMcpId !== ownership.virtualMcpId
    ) {
      throw new Error(
        `Commerce Discovery run ownership conflict: ${ownership.runId}`,
      );
    }
  }

  async findRun(
    organizationId: string,
    runId: string,
  ): Promise<CommerceDiscoveryReportRunOwnership | null> {
    const row = await this.db
      .selectFrom("commerce_discovery_report_runs")
      .select(["site_url", "virtual_mcp_id"])
      .where("organization_id", "=", organizationId)
      .where("run_id", "=", runId)
      .executeTakeFirst();
    return row
      ? {
          organizationId,
          runId,
          siteUrl: row.site_url,
          virtualMcpId: row.virtual_mcp_id,
        }
      : null;
  }
}
