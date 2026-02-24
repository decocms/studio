/**
 * Hooks for fetching report data via the REPORTS_BINDING tools.
 * Lists all reports without category filter.
 */

import { useQuery } from "@tanstack/react-query";
import {
  REPORTS_BINDING,
  type ReportsListOutput,
  type Report,
} from "@decocms/bindings";
import { usePluginContext } from "@decocms/mesh-sdk/plugins";
import { KEYS } from "../lib/query-keys";

/**
 * Fetch the list of all reports (no category filter).
 */
export function useRankingReportsList() {
  const { connectionId, toolCaller } =
    usePluginContext<typeof REPORTS_BINDING>();

  return useQuery({
    queryKey: KEYS.reportsList(connectionId),
    queryFn: async (): Promise<ReportsListOutput> => {
      const result = await toolCaller("REPORTS_LIST", {});
      return result;
    },
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Fetch a single report by ID with full content.
 */
export function useRankingReport(reportId: string) {
  const { connectionId, toolCaller } =
    usePluginContext<typeof REPORTS_BINDING>();

  return useQuery({
    queryKey: KEYS.report(connectionId, reportId),
    queryFn: async (): Promise<Report> => {
      const result = await toolCaller("REPORTS_GET", { id: reportId });
      return result;
    },
    enabled: !!reportId,
    staleTime: 60 * 1000, // 1 minute
  });
}
