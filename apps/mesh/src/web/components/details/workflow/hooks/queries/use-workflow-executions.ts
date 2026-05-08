import { useWorkflowBindingConnection } from "../use-workflow-binding-connection";
import { useWorkflow } from "../../stores/workflow";
import type { WorkflowExecution } from "@decocms/bindings/workflow";
import {
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";

interface WorkflowExecutionsListResponse {
  items: WorkflowExecution[];
}

/**
 * Hook to list all executions for the current workflow.
 * Returns executions sorted by most recent first.
 */
export function useWorkflowExecutions() {
  const { org } = useProjectContext();
  const connection = useWorkflowBindingConnection();
  const workflow = useWorkflow();

  const client = useMCPClient({
    connectionId: connection.id,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, isLoading, refetch } =
    useMCPToolCallQuery<WorkflowExecutionsListResponse>({
      client,
      toolName: "COLLECTION_WORKFLOW_EXECUTION_LIST",
      toolArguments: {
        workflow_collection_id: workflow.id,
        limit: 100,
      },
      enabled: !!workflow.id,
      staleTime: 5000,
      select: (result) =>
        ((result as { structuredContent?: unknown }).structuredContent ??
          result) as WorkflowExecutionsListResponse,
    });

  return {
    executions: data?.items ?? [],
    isLoading,
    refetch,
  };
}
