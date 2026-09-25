/** Task board analytics: the six tools, plus who may read across orgs. */

import { useProjectContext } from "@/sdk";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { KEYS } from "@/lib/query-keys";
import { callStudioTool, useStudioTools } from "@/lib/studio-tools";
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
 * Server-gated, not just hidden: `isTaskBoardAdmin` is true only inside an
 * admin org, and only for its members; everyone else gets an empty list.
 *
 * Asked of the org in the PATH, never of `ProjectContext` — while the board is
 * pointed at another tenant (`BoardOrgProvider`) the context org is that
 * tenant, which is not an admin org, and asking it would switch the picker off
 * the moment it was used.
 */
export function useTaskBoardAdminOrgs() {
  const pathOrg = useParams({ strict: false }).org ?? "";
  return useQuery({
    queryKey: KEYS.taskBoardAdminOrgs(pathOrg),
    enabled: !!pathOrg,
    queryFn: () => callStudioTool(pathOrg, "TASK_BOARD_ADMIN_ORG_LIST", {}),
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
    queryFn: () => studio.call(tool, params),
  });
}
