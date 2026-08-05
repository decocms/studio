import { type Kysely, sql } from "kysely";

/**
 * Commerce Discovery "Report Agent" — expose every reports-MCP tool.
 *
 * getWellKnownReportVirtualMCP aggregated the reports connection
 * with selected_tools = ["get_my_diagnostic"], so the gateway refused every
 * OTHER tool the report widget calls through it — the "Rodar novamente"
 * button (rerun_my_diagnostic), the paywall checkout (start_checkout) and
 * sharing (share_my_diagnostic) all failed with
 * `GatewayClient: unknown namespace ... not found by original name in any
 * client`. The template now creates the aggregation with selected_tools =
 * null (= all tools); this backfills the aggregations created before that.
 *
 * Scoped to the well-known Report Agent parents AND to rows still carrying
 * the exact default selection, so a deliberately customized aggregation is
 * never widened.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE connection_aggregations
    SET selected_tools = NULL
    WHERE parent_connection_id LIKE 'commerce-discovery\_%'
      AND selected_tools = '["get_my_diagnostic"]'
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    UPDATE connection_aggregations
    SET selected_tools = '["get_my_diagnostic"]'
    WHERE parent_connection_id LIKE 'commerce-discovery\_%'
      AND selected_tools IS NULL
  `.execute(db);
}
