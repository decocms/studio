/**
 * Per-org Jira integration (`JIRA_*` tools) — managed from Settings → Tasks.
 * One integration per org: credentials, the board it watches, the webhook
 * that tells it when an issue moves, and the per-status rules that start an
 * agent run when an issue enters a status.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StudioToolIO } from "@decocms/shared/tools/tool-io";
import { useProjectContext } from "@/sdk";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

export type JiraIntegration = NonNullable<
  StudioToolIO["JIRA_INTEGRATION_GET"]["output"]["integration"]
>;

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
    queryKey: KEYS.jiraBoardColumns(org.id, boardId),
    enabled: boardId !== null,
    staleTime: 60_000,
    queryFn: async () =>
      (await studio.call("JIRA_BOARD_COLUMNS_LIST", { boardId: boardId ?? "" }))
        .columns,
  });
}

export type JiraAutomation =
  StudioToolIO["JIRA_AUTOMATION_LIST"]["output"]["automations"][number];

export function useJiraAutomations() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.jiraAutomations(org.id),
    queryFn: async () =>
      (await studio.call("JIRA_AUTOMATION_LIST", {})).automations,
  });
}

/**
 * Turn a status rule on, off, or reword it.
 *
 * `null` is off: the row is deleted rather than stored empty, so "no rule" has
 * one representation. An empty prompt is stored as no prompt, which means the
 * agent runs on its own instruction.
 */
export function useSetJiraAutomation() {
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      jiraStatus: string;
      prompt: string | null;
    }) => {
      if (input.prompt === null) {
        await studio.call("JIRA_AUTOMATION_DELETE", {
          jiraStatus: input.jiraStatus,
        });
        return;
      }
      await studio.call("JIRA_AUTOMATION_UPSERT", {
        jiraStatus: input.jiraStatus,
        prompt: input.prompt.trim() === "" ? undefined : input.prompt,
      });
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: KEYS.jiraAutomations(org.id) }),
  });
}
