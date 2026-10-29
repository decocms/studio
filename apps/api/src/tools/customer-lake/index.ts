/**
 * CUSTOMER_LAKE_QUERY — read-only raw SQL over the organization's own data
 * lake. Isolation is ClickHouse's: the query runs as the org's own user, which a
 * row policy clamps to the org's rows (see customer-lake/client.ts).
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import {
  isCustomerLakeConfigured,
  MAX_RESULT_ROWS,
  queryCustomerLake,
} from "../../customer-lake/client";

export const CUSTOMER_LAKE_QUERY = defineTool({
  name: "CUSTOMER_LAKE_QUERY",
  description: `Run one read-only ClickHouse SQL statement over this organization's data lake: orders and order status changes ingested from the stores it connected (VTEX first), and traffic from its sites running Deco Analytics. Only this organization's rows are visible. Results stop at ${MAX_RESULT_ROWS} rows and queries at 30 s, so aggregate in SQL.

Database customer_lake:
- orders: latest snapshot per order, read with FINAL. status is pending | paid | fulfilled | canceled (source_status keeps the platform's value); created_at, updated_at (UTC), total, items_total, discounts_total, shipping_total (Decimal, in currency), item_count, sales_channel, origin, coupon, utm_source/medium/campaign, payment_methods, ship_country/state/city, customer_key (hashed), items Array(Tuple(sku_id, product_id, ref_id, name, brand, category, quantity, list_price, price, seller)) — use ARRAY JOIN; items_known is false for history backfilled without lines.
- order_events: status changes (order_id, status, source_status, changed_at).
- connections: one row per store: timezone (IANA) and currency. toTimeZone needs a constant zone: read the store's timezone first, then write it as a literal, e.g. toTimeZone(created_at, 'America/Sao_Paulo').
- raw_records: redacted source payloads as JSON (payload), 180-day retention.
- site_traffic_hourly: per site_id, hour (UTC), device and country: visitors (a uniq state — read uniqMerge(visitors), never sum it), pageviews, events, errors, conversions, revenue. Read with FINAL; the current hour fills in within about a minute. analytics_sites maps each site_id to the org. No rows means none of the org's sites sends Deco Analytics yet; ANALYTICS_INSTALL adds it.
- site_dims_hourly: the same sites per hour, broken down by one dimension at a time (dim: path, sourceDomain, channel, country, browser, os, device, name, utmCampaign, utmSource, utmMedium; value): visitors (uniq state), pageviews, events. Read with FINAL; dimensions don't combine.
Every store table has org_id, connection_id, source and store; the site tables have org_id and site_id. Run DESCRIBE TABLE customer_lake.<table> for all columns. Don't add a FORMAT clause.`,
  annotations: {
    title: "Query Customer Data Lake",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({
    sql: z
      .string()
      .min(1)
      .max(20_000)
      .describe("One SELECT, DESCRIBE, SHOW or EXPLAIN statement"),
  }),
  outputSchema: z.object({
    rows: z.array(z.record(z.string(), z.unknown())),
    rowCount: z.number(),
    /** True when the row cap cut the result short. */
    truncated: z.boolean(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const org = requireOrganization(ctx);
    if (!isCustomerLakeConfigured()) {
      throw new Error(
        "The customer data lake is not configured on this deployment",
      );
    }
    const rows = await queryCustomerLake(org.id, input.sql);
    const kept = rows.slice(0, MAX_RESULT_ROWS);
    return {
      rows: kept,
      rowCount: kept.length,
      truncated: rows.length > MAX_RESULT_ROWS,
    };
  },
});
