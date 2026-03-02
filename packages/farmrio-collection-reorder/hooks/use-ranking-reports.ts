/**
 * Hooks for fetching report data via FARMRIO_REORDER_BINDING tools.
 */

import { useQuery } from "@tanstack/react-query";
import {
  FARMRIO_REORDER_BINDING,
  type FarmrioReport,
  type FarmrioReportSummary,
  type FarmrioCollectionItem,
} from "@decocms/bindings";
import { usePluginContext } from "@decocms/mesh-sdk/plugins";
import { KEYS } from "../lib/query-keys";

/**
 * Fetch the list of reports for a given collection (by DB id).
 */
export function useRankingReportsList(collectionDbId: number) {
  const { connectionId, toolCaller } =
    usePluginContext<typeof FARMRIO_REORDER_BINDING>();

  return useQuery({
    queryKey: KEYS.reportsList(connectionId, collectionDbId),
    queryFn: async (): Promise<FarmrioReportSummary[]> => {
      const result = await toolCaller("report_list", {
        collectionId: collectionDbId,
        limit: 200,
      });
      return result.items ?? [];
    },
    enabled: !!collectionDbId,
    staleTime: 60 * 1000,
  });
}

/**
 * Fetch a single report by DB id with full content (includes sections).
 */
export function useRankingReport(reportId: number) {
  const { connectionId, toolCaller } =
    usePluginContext<typeof FARMRIO_REORDER_BINDING>();

  return useQuery({
    queryKey: KEYS.report(connectionId, reportId),
    queryFn: async (): Promise<FarmrioReport> => {
      const result = await toolCaller("report_get", { id: reportId });
      if (!result.item) {
        throw new Error("Report not found");
      }
      return result.item;
    },
    enabled: !!reportId,
    staleTime: 60 * 1000,
  });
}

/**
 * Fetch the list of enabled collections.
 */
export function useCollectionsList() {
  const { connectionId, toolCaller } =
    usePluginContext<typeof FARMRIO_REORDER_BINDING>();

  return useQuery({
    queryKey: KEYS.collectionsList(connectionId),
    queryFn: async (): Promise<FarmrioCollectionItem[]> => {
      const result = await toolCaller("collection_list", {
        isEnabled: true,
        limit: 200,
      });
      return result.items ?? [];
    },
    staleTime: 30 * 1000,
  });
}
