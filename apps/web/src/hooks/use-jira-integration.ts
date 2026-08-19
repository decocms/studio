/**
 * Per-org Jira integration (`JIRA_*` tools) — managed from Settings → Jira.
 * One integration per org: credentials, one synced project, and the
 * per-tenant Jira-status → board-status mapping.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

export type JiraIntegration = NonNullable<
  StudioToolIO["JIRA_INTEGRATION_GET"]["output"]["integration"]
>;
export type JiraSyncRunResult =
  StudioToolIO["JIRA_SYNC_RUN"]["output"]["result"];

export function useJiraIntegration() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.jiraIntegration(org.id),
    queryFn: async () =>
      (await studio.call("JIRA_INTEGRATION_GET", {})).integration,
  });
}

export function useUpsertJiraIntegration() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      input: StudioToolIO["JIRA_INTEGRATION_UPSERT"]["input"],
    ) => (await studio.call("JIRA_INTEGRATION_UPSERT", input)).integration,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.jiraIntegration(org.id) }),
  });
}

export function useDeleteJiraIntegration() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => studio.call("JIRA_INTEGRATION_DELETE", {}),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.jiraIntegration(org.id) }),
  });
}

export function useJiraBoards(connected: boolean) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.jiraBoards(org.id),
    enabled: connected,
    staleTime: 60_000,
    queryFn: async () => (await studio.call("JIRA_BOARDS_LIST", {})).boards,
  });
}

export function useJiraBoardColumns(boardId: string | null) {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.jiraBoardColumns(org.id, boardId ?? ""),
    enabled: boardId !== null,
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("JIRA_BOARD_COLUMNS_LIST", { boardId: boardId ?? "" }))
        .columns,
  });
}

export function useRunJiraSync() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => (await studio.call("JIRA_SYNC_RUN", {})).result,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.jiraIntegration(org.id) }),
  });
}
