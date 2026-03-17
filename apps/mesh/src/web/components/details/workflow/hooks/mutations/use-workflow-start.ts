import {
  useSelectedVirtualMcpId,
  useWorkflow,
  useWorkflowActions,
} from "@/web/components/details/workflow/stores/workflow";
import { useWorkflowBindingConnection } from "../use-workflow-binding-connection";
import { useWorkflowInputSchema } from "../derived/use-workflow-input-schema";
import {
  getDecopilotId,
  useMCPClient,
  useMCPToolCallMutation,
  useProjectContext,
} from "@decocms/mesh-sdk";

export function useWorkflowStart() {
  const { org } = useProjectContext();
  const { id: connectionId } = useWorkflowBindingConnection();
  const { setTrackingExecutionId } = useWorkflowActions();
  const workflow = useWorkflow();
  const selectedVirtualMcpId = useSelectedVirtualMcpId();
  const inputSchema = useWorkflowInputSchema();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
  });
  const { mutateAsync: startWorkflowMutation, isPending } =
    useMCPToolCallMutation({
      client,
    });

  const handleRunWorkflow = async (input: Record<string, unknown> = {}) => {
    const virtualMcpId = selectedVirtualMcpId ?? getDecopilotId(org.id);
    const startAtEpochMs = Date.now();
    const result = await startWorkflowMutation({
      name: "WORKFLOW_EXECUTION_CREATE",
      arguments: {
        input,
        virtual_mcp_id: virtualMcpId,
        start_at_epoch_ms: startAtEpochMs,
        workflow_collection_id: workflow.id,
      },
    });

    const resultData =
      (result as unknown as { structuredContent?: unknown })
        .structuredContent ?? result;
    const executionId =
      (resultData as { item?: { id?: string } })?.item?.id ?? undefined;
    setTrackingExecutionId(executionId);
    return executionId;
  };

  /** Whether the workflow requires input before running */
  const requiresInput = inputSchema !== null;

  return { handleRunWorkflow, isPending, requiresInput, inputSchema };
}

export function useWorkflowCancel() {
  const { org } = useProjectContext();
  const { id: connectionId } = useWorkflowBindingConnection();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
  });
  const { mutateAsync: cancelWorkflowMutation, isPending: isCancelling } =
    useMCPToolCallMutation({ client });

  const handleCancelWorkflow = async (executionId: string) => {
    const result = await cancelWorkflowMutation({
      name: "CANCEL_EXECUTION",
      arguments: { executionId },
    });
    return result;
  };

  return { handleCancelWorkflow, isCancelling };
}

export function useWorkflowResume() {
  const { org } = useProjectContext();
  const { id: connectionId } = useWorkflowBindingConnection();
  const client = useMCPClient({
    connectionId,
    orgId: org.id,
  });
  const { mutateAsync: resumeWorkflowMutation, isPending: isResuming } =
    useMCPToolCallMutation({ client });

  const handleResumeWorkflow = async (executionId: string) => {
    const result = await resumeWorkflowMutation({
      name: "RESUME_EXECUTION",
      arguments: { executionId },
    });
    const resultData =
      (result as unknown as { structuredContent?: unknown })
        .structuredContent ?? result;
    return (resultData as { success?: boolean })?.success ?? false;
  };

  return { handleResumeWorkflow, isResuming };
}
