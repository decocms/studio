import {
  ToolCallAction,
  Workflow,
  WorkflowExecution,
} from "@decocms/bindings/workflow";
import {
  useTrackingExecutionId,
  useWorkflow,
  useWorkflowActions,
  WorkflowStoreProvider,
} from "@/web/components/details/workflow/stores/workflow";
import { MonacoCodeEditor } from "./components/monaco-editor";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@deco/ui/components/resizable.js";
import { Badge } from "@deco/ui/components/badge.js";
import { Button } from "@deco/ui/components/button.js";
import { AlertOctagon, Check, Clock, Eye, FileIcon, X } from "lucide-react";
import { WorkflowEditorHeader } from "./components/workflow-editor-header";
import { WorkflowStepsCanvas } from "./components/workflow-steps-canvas";
import { ToolSidebar } from "./components/tool-sidebar";
import { StepDetailPanel } from "./components/step-detail-panel";
import { ExecutionsList } from "./components/executions-list";
import { useViewModeStore } from "./stores/view-mode";
import { useCurrentStep } from "./stores/workflow";
import { ViewLayout } from "../layout";
import { useParams } from "@tanstack/react-router";
import {
  useCollectionActions,
  useCollectionItem,
  useConnections,
  useMCPClient,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { getConnectionSlug } from "@/web/utils/connection-slug";
import { EmptyState } from "@deco/ui/components/empty-state.js";
import { usePollingWorkflowExecution } from "./hooks";
import { useWorkflowSSE } from "./hooks/use-workflow-sse";
import { useRef, useState, useSyncExternalStore } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// Shared hook for workflow/execution data
// ─────────────────────────────────────────────────────────────────────────────

export function useCollectionWorkflow({ itemId }: { itemId: string }) {
  const [isUpdating, setIsUpdating] = useState(false);
  const { appSlug } = useParams({
    from: "/shell/$org/$project/mcps/$appSlug/$collectionName/$itemId",
  });
  const allConnections = useConnections();
  const connection =
    allConnections.find(
      (c) =>
        c.connection_type !== "VIRTUAL" && getConnectionSlug(c) === appSlug,
    ) ?? null;
  const connectionId = connection?.id ?? appSlug;
  const scopeKey = connectionId ?? "no-connection";

  const collectionName = "WORKFLOW";

  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: connectionId ?? null,
    orgId: org.id,
  });

  const item = useCollectionItem<Workflow>(
    scopeKey,
    collectionName,
    itemId,
    client,
  );

  const actions = useCollectionActions<Workflow>(
    scopeKey,
    collectionName,
    client,
  );

  const update = async (updates: Partial<Workflow>): Promise<void> => {
    setIsUpdating(true);
    await actions.update
      .mutateAsync({
        id: itemId,
        data: updates,
      })
      .finally(() => {
        setIsUpdating(false);
      });
  };

  return {
    item,
    update,
    isUpdating,
  };
}

interface WorkflowDetailsProps {
  onUpdate: (updates: Partial<Workflow>) => Promise<void>;
  isUpdating: boolean;
}

function WorkflowCode({
  workflow,
  onUpdate,
}: {
  workflow: Workflow;
  onUpdate: (updates: Partial<Workflow>) => Promise<void>;
}) {
  const { setWorkflow } = useWorkflowActions();
  const wf = {
    title: workflow.title,
    description: workflow.description,
    steps: workflow.steps,
  };
  return (
    <MonacoCodeEditor
      key={`workflow-${workflow.id}`}
      height="100%"
      code={JSON.stringify(wf, null, 2)}
      language="json"
      onSave={(code) => {
        const parsed = JSON.parse(code);
        setWorkflow({
          ...workflow,
          ...parsed,
        });
        onUpdate(parsed);
      }}
    />
  );
}

function useExecutionDuration() {
  const trackingExecutionId = useTrackingExecutionId();
  const { item: executionItem } =
    usePollingWorkflowExecution(trackingExecutionId);
  const startAtEpochMs = executionItem?.start_at_epoch_ms;
  const completedAtEpochMs = executionItem?.completed_at_epoch_ms;

  const shouldSubscribe =
    executionItem?.status === "running" &&
    startAtEpochMs &&
    !completedAtEpochMs;

  const timeRef = useRef(Date.now());

  const subscribe = (callback: () => void) => {
    if (!shouldSubscribe) return () => {};

    const interval = setInterval(() => {
      timeRef.current = Date.now();
      callback();
    }, 50);

    return () => clearInterval(interval);
  };

  const getSnapshot = () => {
    return shouldSubscribe ? timeRef.current : 0;
  };

  const currentTime = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Calculate duration in real-time (directly in render, NOT in useMemo!)
  const activeDuration =
    completedAtEpochMs && startAtEpochMs
      ? Math.max(0, completedAtEpochMs - startAtEpochMs)
      : null;
  let duration: number | null = null;
  if (startAtEpochMs) {
    const start = new Date(startAtEpochMs).getTime();
    if (completedAtEpochMs) {
      // If endTime exists, use it
      const end = new Date(completedAtEpochMs).getTime();
      duration = Math.max(0, end - start);
    } else if (shouldSubscribe) {
      // If no endTime but step is running, use currentTime for live duration
      duration = Math.max(0, currentTime - start);
    }
    // Otherwise duration remains null (shows "-")
  }

  return duration ?? activeDuration;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) {
    return `${milliseconds}ms`;
  }

  const totalSeconds = milliseconds / 1000;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds.toFixed(3)}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds.toFixed(3)}s`;
  }
  return `${seconds.toFixed(3)}s`;
}
function WorkflowExecutionBar() {
  const { setTrackingExecutionId } = useWorkflowActions();
  const trackingExecutionId = useTrackingExecutionId();
  const { item: executionItem } =
    usePollingWorkflowExecution(trackingExecutionId);

  const duration = useExecutionDuration();
  const formattedDuration = duration != null ? formatDuration(duration) : null;
  const status = executionItem?.status;
  const isError = status === "error" || status === "failed";
  const isSuccess = status === "success";
  return (
    <div className="flex flex-col border-b border-border">
      <div className="h-10 bg-accent flex items-center justify-between">
        <div className="flex items-center h-full">
          <div className="flex items-center justify-center h-full w-12">
            <Eye className="w-4 h-4 text-muted-foreground" />
          </div>
          <p className="flex gap-3 items-center h-full">
            <strong className="text-base text-foreground">Run</strong>
            <span className="text-sm text-muted-foreground">
              #{trackingExecutionId}
            </span>
          </p>

          {/* Status badge */}
          {isSuccess && (
            <Badge variant="success" className="gap-1 ml-3">
              <Check size={11} />
              Success
            </Badge>
          )}
          {isError && (
            <Badge variant="destructive" className="gap-1 ml-3">
              <AlertOctagon size={11} />
              Failed
            </Badge>
          )}

          <div className="flex items-center gap-1 ml-6">
            <Clock className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {formattedDuration}
            </span>
          </div>
        </div>

        <Button
          variant="ghost"
          size="xs"
          onClick={() => setTrackingExecutionId(undefined)}
        >
          <X className="w-4 h-4 text-muted-foreground" />
        </Button>
      </div>
    </div>
  );
}

export function WorkflowDetails() {
  const { itemId } = useParams({
    from: "/shell/$org/$project/mcps/$appSlug/$collectionName/$itemId",
  });
  const {
    item: workflow,
    update,
    isUpdating,
  } = useCollectionWorkflow({ itemId });

  const keyFlow = JSON.stringify(workflow);

  if (!workflow) {
    return (
      <ViewLayout>
        <div className="flex h-full w-full bg-background">
          <EmptyState
            icon={<FileIcon className="w-10 h-10 text-muted-foreground" />}
            title="Workflow not found"
            description="This workflow may have been deleted or you may not have access to it."
          />
        </div>
      </ViewLayout>
    );
  }

  return (
    <WorkflowStoreProvider
      key={keyFlow}
      initialState={{
        workflow,
        trackingExecutionId: undefined,
        currentStepTab: "input",
      }}
    >
      <WorkflowStudio onUpdate={update} isUpdating={isUpdating} />
    </WorkflowStoreProvider>
  );
}
function WorkflowStudio({
  onUpdate,
  isUpdating,
}: Omit<WorkflowDetailsProps, "onBack">) {
  // Subscribe to workflow SSE events — invalidates query caches on changes
  useWorkflowSSE();

  const workflow = useWorkflow();
  const trackingExecutionId = useTrackingExecutionId();
  const { viewMode, showExecutionsList } = useViewModeStore();
  const currentStep = useCurrentStep();

  const handleSave = async () => {
    await onUpdate(workflow);
  };

  const isToolStep = currentStep && "toolName" in currentStep.action;
  const toolName = isToolStep
    ? (currentStep.action as ToolCallAction).toolName
    : null;
  const showToolSidebar = isToolStep && !toolName && !trackingExecutionId;
  const showStepDetail =
    !showToolSidebar &&
    (currentStep || trackingExecutionId || !showExecutionsList);

  return (
    <ViewLayout>
      <div className="flex flex-col h-full overflow-hidden bg-background">
        <WorkflowEditorHeader
          title={workflow.title}
          description={workflow.description}
          onSave={handleSave}
          isSaving={isUpdating}
        />

        {/* Tracking Execution Bar */}
        {trackingExecutionId && <WorkflowExecutionBar />}

        {/* Main Content */}
        <div className="flex-1 overflow-hidden">
          {viewMode === "code" ? (
            <WorkflowCode workflow={workflow} onUpdate={onUpdate} />
          ) : (
            <ResizablePanelGroup
              direction="horizontal"
              className="flex w-full h-full"
            >
              {/* Steps Canvas Panel */}
              <ResizablePanel defaultSize={50} minSize={30}>
                <WorkflowStepsCanvas />
              </ResizablePanel>

              <ResizableHandle />

              {/* Right Panel - Executions List OR Step Config */}
              <ResizablePanel defaultSize={50} minSize={25}>
                {showToolSidebar && (
                  <ToolSidebar className="border-l border-border" />
                )}
                {showExecutionsList && <ExecutionsList />}
                {showStepDetail && (
                  <StepDetailPanel className="border-l border-border" />
                )}
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
        </div>
      </div>
    </ViewLayout>
  );
}

function useCollectionWorkflowExecution({ itemId }: { itemId: string }) {
  const { appSlug } = useParams({
    from: "/shell/$org/$project/mcps/$appSlug/$collectionName/$itemId",
  });
  const allConnections = useConnections();
  const connection =
    allConnections.find(
      (c) =>
        c.connection_type !== "VIRTUAL" && getConnectionSlug(c) === appSlug,
    ) ?? null;
  const connectionId = connection?.id ?? appSlug;
  const scopeKey = connectionId ?? "no-connection";

  const collectionName = "WORKFLOW_EXECUTION";

  const { org } = useProjectContext();
  const client = useMCPClient({
    connectionId: connectionId ?? null,
    orgId: org.id,
  });

  const item = useCollectionItem<WorkflowExecution>(
    scopeKey,
    collectionName,
    itemId,
    client,
  );

  return {
    item,
  };
}

export function WorkflowExecutionDetailsView() {
  const { itemId } = useParams({
    from: "/shell/$org/$project/mcps/$appSlug/$collectionName/$itemId",
  });
  const { item: execution } = useCollectionWorkflowExecution({
    itemId: itemId,
  });

  if (!execution) {
    return (
      <ViewLayout>
        <div className="flex h-full w-full bg-background">
          <EmptyState
            icon={<FileIcon className="w-10 h-10 text-muted-foreground" />}
            title="Workflow execution not found"
            description="This workflow execution may have been deleted or you may not have access to it."
          />
        </div>
      </ViewLayout>
    );
  }

  return (
    <ViewLayout>
      <div className="flex flex-col h-full overflow-hidden bg-background">
        <MonacoCodeEditor
          height="100%"
          code={JSON.stringify(execution, null, 2)}
          language="json"
          readOnly={true}
        />
      </div>
    </ViewLayout>
  );
}
