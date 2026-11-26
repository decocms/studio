/**
 * Deco Analytics and the org's data lake, read in-process: the same code the
 * Analytics tab's route and CUSTOMER_LAKE_QUERY run, with the run's context,
 * instead of an HTTP hop back into Studio.
 */

import { readAnalyticsData } from "@/api/routes/hosting";
import type { StudioContext } from "@/core/studio-context";
import {
  isCustomerLakeConfigured,
  MAX_RESULT_ROWS,
  queryCustomerLake,
} from "@/customer-lake/client";
import type {
  HeatmapPayload,
  HeatmapReader,
  LakeQuery,
  LakeRow,
} from "../ports.ts";

const ERROR_BODY_MAX = 300;

/** `ctx` must carry the run's organization (and the member it runs as). */
export function orgHeatmap(ctx: StudioContext): HeatmapReader {
  return async (site, opts) => {
    const { status, body } = await readAnalyticsData(ctx, site, {
      view: "heatmap",
      range: opts.range,
      page: opts.page,
      device: opts.device,
      filters: [],
    });
    if (status >= 400) {
      throw new Error(
        `HTTP ${status}: ${JSON.stringify(body).slice(0, ERROR_BODY_MAX)}`,
      );
    }
    return {
      registered: body.registered !== false,
      siteId: typeof body.siteId === "string" ? body.siteId : null,
      data: (body.data ?? {}) as HeatmapPayload["data"],
    };
  };
}

export function orgLake(orgId: string): LakeQuery {
  return async (sql) => {
    if (!isCustomerLakeConfigured()) {
      throw new Error(
        "The customer data lake is not configured on this deployment",
      );
    }
    const rows = await queryCustomerLake(orgId, sql);
    return rows.slice(0, MAX_RESULT_ROWS) as LakeRow[];
  };
}
