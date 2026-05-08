import { WorkflowExecution } from "@decocms/bindings/workflow";
import { useWorkflowBindingConnection } from "../use-workflow-binding-connection";
import {
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";

type ExecutionQueryResult = {
  item: WorkflowExecution | null;
};

/**
 * Fetch a single workflow execution by ID.
 *
 * Real-time updates are driven by SSE via useWorkflowSSE() which
 * invalidates the query cache when workflow events arrive.
 * No polling needed.
 */
export function usePollingWorkflowExecution(executionId?: string) {
  const { org } = useProjectContext();
  const connection = useWorkflowBindingConnection();

  const client = useMCPClient({
    connectionId: connection.id,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, isLoading } = useMCPToolCallQuery<ExecutionQueryResult>({
    client,
    toolName: "COLLECTION_WORKFLOW_EXECUTION_GET",
    toolArguments: {
      id: executionId,
    },
    enabled: !!executionId,
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as ExecutionQueryResult,
  });

  return {
    item: data?.item,
    isLoading,
  } as {
    item: WorkflowExecution | null;
    isLoading: boolean;
  };
}

export function useExecutionCompletedStep(
  executionId?: string,
  stepName?: string,
  options?: { refetchInterval?: number | false; enabled?: boolean },
) {
  const { org } = useProjectContext();
  const connection = useWorkflowBindingConnection();

  const client = useMCPClient({
    connectionId: connection.id,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const isEnabled = (options?.enabled ?? true) && !!executionId && !!stepName;

  const { data, isLoading } = useMCPToolCallQuery<{
    output: unknown | null;
    error: string | null;
  }>({
    client,
    toolName: "COLLECTION_WORKFLOW_EXECUTION_GET_STEP_RESULT",
    toolArguments: {
      executionId: executionId,
      stepId: stepName,
    },
    enabled: isEnabled,
    select: (result) =>
      ((result as { structuredContent?: unknown }).structuredContent ??
        result) as { output: unknown | null; error: string | null },
  });

  return {
    output: data?.output,
    error: data?.error,
    isLoading,
  } as {
    output: unknown | null;
    error: string | null;
    isLoading: boolean;
  };
}
