import { VirtualMCPSelect } from "./virtual-mcp-select";
import { Button } from "@deco/ui/components/button.tsx";
import { Spinner } from "@deco/ui/components/spinner.tsx";
import { ViewModeToggle } from "@deco/ui/components/view-mode-toggle.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  ClockFastForward,
  Code02,
  GitBranch01,
  Play,
  Stop,
} from "@untitledui/icons";
import { Suspense, useState } from "react";
import { ViewActions, ViewTabs } from "../../layout";
import { SaveActions } from "@/web/components/save-actions";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  usePollingWorkflowExecution,
  useWorkflowCancel,
  useWorkflowResume,
  useWorkflowStart,
} from "../hooks";
import { useViewModeStore } from "../stores/view-mode";
import {
  useIsDirty,
  useSelectedVirtualMcpId,
  useTrackingExecutionId,
  useWorkflowActions,
  useWorkflowSteps,
} from "../stores/workflow";
import { WorkflowInputDialog } from "./workflow-input-dialog";

interface WorkflowEditorHeaderProps {
  title: string;
  description?: string;
  onSave: () => void;
  isSaving: boolean;
}

export function WorkflowEditorHeader({
  title,
  description,
  onSave,
  isSaving,
}: WorkflowEditorHeaderProps) {
  const { viewMode, setViewMode, showExecutionsList, toggleExecutionsList } =
    useViewModeStore();
  const { resetToOriginalWorkflow, setSelectedVirtualMcpId } =
    useWorkflowActions();
  const isDirty = useIsDirty();
  const selectedVirtualMcpId = useSelectedVirtualMcpId();
  const trackingExecutionId = useTrackingExecutionId();

  return (
    <>
      <ViewTabs>
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-foreground truncate">
            {title}
          </span>
          {description ? (
            <>
              <span className="text-xs text-muted-foreground font-normal">
                •
              </span>
              <span className="text-xs text-muted-foreground font-normal truncate min-w-0 max-w-[20ch]">
                {description}
              </span>
            </>
          ) : null}
        </div>
      </ViewTabs>

      <ViewActions>
        {!trackingExecutionId && (
          <>
            <SaveActions
              onSave={onSave}
              onUndo={resetToOriginalWorkflow}
              isDirty={isDirty}
              isSaving={isSaving}
              saveLabel="Save workflow"
              undoLabel="Reset changes"
            />
            <Suspense fallback={<Spinner size="xs" />}>
              <VirtualMCPSelect
                selectedVirtualMcpId={selectedVirtualMcpId}
                onVirtualMcpChange={setSelectedVirtualMcpId}
                placeholder="Select Agent"
              />
            </Suspense>

            <ViewModeToggle
              value={viewMode}
              onValueChange={setViewMode}
              size="sm"
              options={[
                { value: "visual", icon: <GitBranch01 /> },
                { value: "code", icon: <Code02 /> },
              ]}
            />

            <TooltipProvider>
              <Tooltip delayDuration={0}>
                <TooltipTrigger asChild>
                  <span className="inline-block">
                    <Button
                      variant={showExecutionsList ? "secondary" : "outline"}
                      size="icon"
                      className="size-7 border border-input"
                      onClick={toggleExecutionsList}
                      aria-label={
                        showExecutionsList ? "Hide runs" : "Show runs"
                      }
                    >
                      <ClockFastForward size={14} />
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {showExecutionsList ? "Hide runs" : "Show runs"}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        )}

        <RunWorkflowButton />
      </ViewActions>
    </>
  );
}

function useIsExecutionCompleted() {
  const trackingExecutionId = useTrackingExecutionId();
  const { item } = usePollingWorkflowExecution(trackingExecutionId);
  return item?.completed_at_epoch_ms != null;
}

function useIsExecutionCancelled() {
  const trackingExecutionId = useTrackingExecutionId();
  const { item } = usePollingWorkflowExecution(trackingExecutionId);
  return item?.status === "cancelled";
}

function RunWorkflowButton() {
  const isDirty = useIsDirty();
  const isExecutionCompleted = useIsExecutionCompleted();
  const isExecutionCancelled = useIsExecutionCancelled();
  const trackingExecutionId = useTrackingExecutionId();
  const selectedVirtualMcpId = useSelectedVirtualMcpId();
  const { handleRunWorkflow, isPending, requiresInput, inputSchema } =
    useWorkflowStart();
  const steps = useWorkflowSteps();
  const [showInputDialog, setShowInputDialog] = useState(false);
  const { handleCancelWorkflow, isCancelling } = useWorkflowCancel();
  const { handleResumeWorkflow, isResuming } = useWorkflowResume();
  const trackingExecutionIsRunning =
    trackingExecutionId && !isExecutionCompleted;

  const hasEmptySteps = steps.some(
    (step) =>
      "toolName" in step.action &&
      (!step.action.toolName || step.action.toolName === ""),
  );

  const hasNoVirtualMcp = !selectedVirtualMcpId;
  const noSteps = steps.length === 0;

  const isDisabled =
    isDirty ||
    noSteps ||
    hasEmptySteps ||
    hasNoVirtualMcp ||
    isPending ||
    isCancelling;

  const isRunning = trackingExecutionIsRunning || isPending;
  const getTooltipMessage = () => {
    if (isExecutionCancelled) return "Workflow is currently cancelled";
    if (isRunning) return "Workflow is currently running";
    if (isDirty) return "Save your changes before running";
    if (hasNoVirtualMcp) return "Select an Agent first";
    if (noSteps) return "Add at least one step to the workflow";
    if (hasEmptySteps) return "Add at least one step to the workflow";
    return null;
  };

  const tooltipMessage = getTooltipMessage();

  const handleClick = async () => {
    if (requiresInput && inputSchema) {
      setShowInputDialog(true);
      return;
    }

    if (isExecutionCancelled && trackingExecutionId) {
      await handleResumeWorkflow(trackingExecutionId);
      return;
    }

    if (isRunning && trackingExecutionId) {
      await handleCancelWorkflow(trackingExecutionId);
      return;
    }

    await handleRunWorkflow({});
  };

  const handleInputSubmit = async (input: Record<string, unknown>) => {
    await handleRunWorkflow(input);
  };

  const buttonLabel = isExecutionCancelled
    ? "Resume"
    : trackingExecutionId
      ? isExecutionCompleted
        ? "Replay"
        : "Running..."
      : requiresInput
        ? "Run with input..."
        : "Run workflow";

  const button = (
    <Button
      variant="default"
      size="sm"
      className={cn(
        "gap-2 h-7 px-3",
        !trackingExecutionIsRunning &&
          "bg-primary text-primary-foreground hover:bg-primary/90",
      )}
      disabled={isDisabled}
      onClick={handleClick}
    >
      {((!trackingExecutionIsRunning &&
        !isPending &&
        !isCancelling &&
        !isResuming) ||
        isExecutionCancelled) && <Play size={14} />}
      {trackingExecutionIsRunning &&
        !isPending &&
        !isCancelling &&
        !isResuming &&
        !isExecutionCancelled && <Stop size={14} />}
      {(isPending || isCancelling || isResuming) && <Spinner size="xs" />}
      {buttonLabel}
    </Button>
  );

  const buttonWithTooltip = tooltipMessage ? (
    <TooltipProvider>
      <Tooltip delayDuration={0}>
        <TooltipTrigger asChild>
          <span className="inline-block">{button}</span>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipMessage}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  ) : (
    button
  );

  return (
    <>
      {buttonWithTooltip}
      {requiresInput && inputSchema && (
        <WorkflowInputDialog
          open={showInputDialog}
          onOpenChange={setShowInputDialog}
          inputSchema={inputSchema}
          onSubmit={handleInputSubmit}
          isPending={isPending}
        />
      )}
    </>
  );
}
