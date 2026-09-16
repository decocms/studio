/** Task board analytics: the six tools, plus who may read across orgs. */

import { useProjectContext } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import type { StudioToolOutput as ToolOutput } from "@decocms/shared/tools/tool-io";

export type AnalyticsPayload = ToolOutput<"TASK_BOARD_DELIVERY">;
export type AnalyticsSection = AnalyticsPayload["sections"][number];

export const ANALYTICS_TOOLS = [
  "TASK_BOARD_DELIVERY",
  "TASK_BOARD_STUCK",
  "TASK_BOARD_COST",
  "TASK_BOARD_QUALITY",
  "TASK_BOARD_ERRORS",
  "TASK_BOARD_TENANTS",
] as const;

export type AnalyticsTool = (typeof ANALYTICS_TOOLS)[number];

/**
 * Server-gated, not just hidden: a non-admin gets `isTaskBoardAdmin: false` and
 * an empty list, and the analytics tools refuse a cross-org `org` regardless.
 */
export function useTaskBoardAdminOrgs() {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.taskBoardAdminOrgs(locator),
    queryFn: () => studio.call("TASK_BOARD_ADMIN_ORG_LIST", {}),
    staleTime: 5 * 60_000,
  });
}

export function useTaskBoardAnalytics(
  tool: AnalyticsTool,
  params: { org: string; from: string; to: string },
) {
  const { locator } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.taskBoardAnalytics(
      locator,
      tool,
      params.org,
      params.from,
      params.to,
    ),
    queryFn: () => studio.call(tool, params) as Promise<AnalyticsPayload>,
  });
}
