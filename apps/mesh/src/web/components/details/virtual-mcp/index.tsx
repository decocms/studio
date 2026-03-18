import type { VirtualMCPEntity } from "@/tools/virtual/schema";
import { useChatStable } from "@/web/components/chat/context";
import { EmptyState } from "@/web/components/empty-state.tsx";
import { ErrorBoundary } from "@/web/components/error-boundary";
import { IconPicker } from "@/web/components/icon-picker.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Collapsible,
  CollapsibleTrigger,
} from "@deco/ui/components/collapsible.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  ORG_ADMIN_PROJECT_SLUG,
  useConnection,
  useProjectContext,
  useVirtualMCP,
  useVirtualMCPActions,
} from "@decocms/mesh-sdk";
import { zodResolver } from "@hookform/resolvers/zod";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ChevronRight,
  ChevronUp,
  CubeOutline,
  File02,
  Loading01,
  Play,
  Plus,
  ZapCircle,
  Tool01,
  Users03,
} from "@untitledui/icons";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Suspense, useEffect, useReducer } from "react";
import { Controller, useForm } from "react-hook-form";
import { ViewActions, ViewLayout } from "../layout";
import { SaveActions } from "@/web/components/save-actions";
import { DependencySelectionDialog } from "./dependency-selection-dialog";
import { getSelectionCount } from "./selection-utils";
import type { VirtualMCPConnection } from "@decocms/mesh-sdk/types";
import { VirtualMcpFormSchema, type VirtualMcpFormData } from "./types";
import { VirtualMCPShareModal } from "./virtual-mcp-share-modal";
import { AgentConnectionsPreview } from "@/web/components/connections/agent-connections-preview.tsx";

type DialogState = {
  shareDialogOpen: boolean;
  connectionDialogOpen: boolean;
  editingConnectionId: string | null;
  skillsOpen: boolean;
};

type DialogAction =
  | { type: "SET_SHARE_DIALOG_OPEN"; payload: boolean }
  | { type: "SET_CONNECTION_DIALOG_OPEN"; payload: boolean }
  | { type: "SET_EDITING_CONNECTION_ID"; payload: string | null }
  | { type: "SET_SKILLS_OPEN"; payload: boolean };

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "SET_SHARE_DIALOG_OPEN":
      return { ...state, shareDialogOpen: action.payload };
    case "SET_CONNECTION_DIALOG_OPEN":
      return { ...state, connectionDialogOpen: action.payload };
    case "SET_EDITING_CONNECTION_ID":
      return { ...state, editingConnectionId: action.payload };
    case "SET_SKILLS_OPEN":
      return { ...state, skillsOpen: action.payload };
    default:
      return state;
  }
}

/**
 * Skill Item Component - Shows a connection with inline badges
 */
function SkillItem({
  connection_id,
  selected_tools,
  selected_resources,
  selected_prompts,
  onClick,
}: Pick<
  VirtualMCPConnection,
  "connection_id" | "selected_tools" | "selected_resources" | "selected_prompts"
> & {
  onClick: () => void;
}) {
  const connection = useConnection(connection_id);

  if (!connection) return null;

  // Use getSelectionCount to properly handle null (all selected) vs array
  const toolCount = getSelectionCount(selected_tools);
  const resourceCount = getSelectionCount(selected_resources);
  const promptCount = getSelectionCount(selected_prompts);

  return (
    <div
      onClick={onClick}
      className="w-full h-12 flex items-center gap-2 px-3 rounded-lg border border-border hover:bg-accent/50 transition-colors cursor-pointer"
    >
      <IntegrationIcon
        icon={connection.icon}
        name={connection.title}
        size="xs"
      />
      <p className="flex-1 text-sm font-normal text-foreground truncate">
        {connection.title}
      </p>
      <Badge
        variant="secondary"
        className="bg-muted h-5 gap-2 px-1.5 py-1 flex items-center"
      >
        {toolCount !== 0 && (
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <span>{toolCount === "all" ? "all" : toolCount}</span>
            <Tool01 size={12} />
          </div>
        )}
        {resourceCount !== 0 && (
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <span>{resourceCount === "all" ? "all" : resourceCount}</span>
            <CubeOutline size={12} />
          </div>
        )}
        {promptCount !== 0 && (
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <span>{promptCount === "all" ? "all" : promptCount}</span>
            <File02 size={12} />
          </div>
        )}
      </Badge>
      <ChevronRight size={16} className="text-muted-foreground shrink-0" />
    </div>
  );
}

/**
 * Skill Item Fallback Component - Shows loading state while connection loads
 */
SkillItem.Fallback = function SkillItemFallback() {
  return (
    <div className="w-full h-12 flex items-center gap-2 px-3 rounded-lg border border-border">
      <div className="size-5 rounded bg-muted animate-pulse shrink-0" />
      <div className="flex-1 h-4 rounded bg-muted animate-pulse" />
      <Badge
        variant="secondary"
        className="bg-muted h-5 gap-2 px-1.5 py-1 flex items-center"
      >
        <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
          <div className="w-3 h-3 rounded bg-muted-foreground/20 animate-pulse" />
          <Tool01 size={12} />
        </div>
        <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
          <div className="w-3 h-3 rounded bg-muted-foreground/20 animate-pulse" />
          <CubeOutline size={12} />
        </div>
        <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
          <div className="w-3 h-3 rounded bg-muted-foreground/20 animate-pulse" />
          <File02 size={12} />
        </div>
      </Badge>
      <ChevronRight size={16} className="text-muted-foreground shrink-0" />
    </div>
  );
};

function VirtualMcpDetailViewWithData({
  virtualMcp,
}: {
  virtualMcp: VirtualMCPEntity;
}) {
  const { org } = useProjectContext();
  const actions = useVirtualMCPActions();

  // Form setup
  const form = useForm<VirtualMcpFormData>({
    resolver: zodResolver(VirtualMcpFormSchema),
    defaultValues: virtualMcp,
  });

  // Watch connections for reactive UI
  const connections = form.watch("connections");

  // Dialog states
  const [dialogState, dispatch] = useReducer(dialogReducer, {
    shareDialogOpen: false,
    connectionDialogOpen: false,
    editingConnectionId: null,
    skillsOpen: false,
  });

  // Auto-open chat with this agent selected
  const [, setChatOpen] = useDecoChatOpen();
  const { setVirtualMcpId } = useChatStable();

  // Open chat on mount (without selecting the agent)
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    setChatOpen(true);
    setVirtualMcpId(virtualMcp.id);
    // eslint-disable-next-line react-hooks/exhaustive-depsbun
  }, [virtualMcp.id]);

  const handleTestAgent = () => {
    setVirtualMcpId(virtualMcp.id);
    setChatOpen(true);
  };

  const hasFormChanges = form.formState.isDirty;

  const handleSave = async () => {
    const formData = form.getValues();

    const data = await actions.update.mutateAsync({
      id: virtualMcp.id,
      data: formData,
    });

    form.reset(data);
  };

  const handleCancel = () => {
    form.reset(virtualMcp);
  };

  const handleAddConnection = () => {
    dispatch({ type: "SET_EDITING_CONNECTION_ID", payload: null });
    dispatch({ type: "SET_CONNECTION_DIALOG_OPEN", payload: true });
  };

  const handleEditConnection = (connectionId: string) => {
    dispatch({ type: "SET_EDITING_CONNECTION_ID", payload: connectionId });
    dispatch({ type: "SET_CONNECTION_DIALOG_OPEN", payload: true });
  };

  const isSaving = actions.update.isPending;

  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to="/$org/$project/agents"
              params={{ org: org.slug, project: ORG_ADMIN_PROJECT_SLUG }}
            >
              Agents
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{virtualMcp.title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <ViewActions>
        <SaveActions
          onSave={handleSave}
          onUndo={handleCancel}
          isDirty={hasFormChanges}
          isSaving={isSaving}
        />
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <span className="inline-block">
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1.5 px-2 border border-input"
                onClick={handleTestAgent}
                aria-label="Test Agent"
              >
                <Play size={14} />
                Test Agent
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom">Test this agent in chat</TooltipContent>
        </Tooltip>

        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1.5 px-2 border border-input"
          onClick={() =>
            dispatch({ type: "SET_SHARE_DIALOG_OPEN", payload: true })
          }
        >
          <ZapCircle size={14} />
          Connect
        </Button>
      </ViewActions>

      <div className="flex h-full w-full bg-background overflow-auto">
        <div className="flex flex-col w-full">
          {/* Header section */}
          <div className="flex items-start justify-between gap-4 p-6 shrink-0">
            <div className="flex items-start gap-4 flex-1 min-w-0">
              <Controller
                control={form.control}
                name="icon"
                render={({ field }) => (
                  <IconPicker
                    value={field.value}
                    onChange={field.onChange}
                    name={form.watch("title") || "Agent"}
                    size="lg"
                    className="shrink-0 shadow-sm"
                    fallbackIcon={<Users03 />}
                  />
                )}
              />
              <div className="flex flex-col flex-1 min-w-0">
                <Input
                  {...form.register("title")}
                  className="h-auto py-0.5 text-lg! font-medium leading-7 px-1 -mx-1 border-transparent hover:bg-input/25 focus:border-input bg-transparent transition-all"
                  placeholder="Agent Name"
                />
                <Input
                  {...form.register("description")}
                  className="h-auto py-0.5 text-base text-muted-foreground leading-6 px-1 -mx-1 border-transparent hover:bg-input/25 focus:border-input bg-transparent transition-all"
                  placeholder="Add a description..."
                />
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Switch
                checked={form.watch("status") === "active"}
                onCheckedChange={(checked) =>
                  form.setValue("status", checked ? "active" : "inactive", {
                    shouldDirty: true,
                  })
                }
              />
            </div>
          </div>

          {/* Skills section - Collapsible */}
          <Collapsible
            open={dialogState.skillsOpen}
            onOpenChange={(open) =>
              dispatch({ type: "SET_SKILLS_OPEN", payload: open })
            }
            className="border-t border-border shrink-0 max-h-[400px] overflow-hidden flex flex-col"
          >
            {connections.length === 0 ? (
              <div className="px-6 py-4 flex flex-col gap-3">
                <p className="text-sm font-medium text-muted-foreground">
                  Connections
                </p>
                <button
                  type="button"
                  onClick={handleAddConnection}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border hover:bg-accent/50 transition-colors w-full text-left cursor-pointer overflow-hidden"
                >
                  <div className="relative flex items-center justify-center size-8 rounded-md text-muted-foreground/75 shrink-0">
                    <svg
                      className="absolute inset-0 size-full overflow-hidden"
                      fill="none"
                      viewBox="0 0 32 32"
                    >
                      <defs>
                        <linearGradient
                          id="agent-detail-border-gradient"
                          gradientUnits="userSpaceOnUse"
                          x1="0"
                          y1="0"
                          x2="32"
                          y2="32"
                        >
                          <animateTransform
                            attributeName="gradientTransform"
                            type="rotate"
                            from="0 16 16"
                            to="360 16 16"
                            dur="6s"
                            repeatCount="indefinite"
                          />
                          <stop offset="0%" stopColor="var(--chart-1)" />
                          <stop offset="100%" stopColor="var(--chart-4)" />
                        </linearGradient>
                      </defs>
                      <rect
                        x="0.5"
                        y="0.5"
                        width="31"
                        height="31"
                        rx="5.5"
                        stroke="url(#agent-detail-border-gradient)"
                        strokeWidth="1"
                        strokeDasharray="3 3"
                      />
                    </svg>
                    <Plus size={16} />
                  </div>
                  <span className="text-sm text-muted-foreground truncate">
                    No connections yet. Add one to get started.
                  </span>
                </button>
              </div>
            ) : (
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="w-full flex items-center justify-between px-6 py-4 hover:bg-muted/50 transition-colors cursor-pointer"
                >
                  <p className="text-sm font-medium text-muted-foreground">
                    Connections
                  </p>
                  <div className="flex items-center">
                    {/* Icons preview - collapses instantly when open, expands smoothly when closed */}
                    <div
                      className="ease-(--ease-out-expo)"
                      style={{
                        width: dialogState.skillsOpen ? 0 : "auto",
                        marginRight: dialogState.skillsOpen ? 0 : 4,
                        opacity: dialogState.skillsOpen ? 0 : 1,
                        pointerEvents: dialogState.skillsOpen ? "none" : "auto",
                        transitionProperty: "all",
                        transitionDuration: dialogState.skillsOpen
                          ? "0ms"
                          : "200ms",
                      }}
                    >
                      <AgentConnectionsPreview
                        connectionIds={connections.map((c) => c.connection_id)}
                        maxVisibleIcons={2}
                      />
                    </div>
                    {/* Plus button that expands to "+ Add" when open */}
                    <div
                      role="button"
                      tabIndex={0}
                      className="h-7 inline-flex items-center justify-center rounded-md text-sm text-muted-foreground overflow-hidden transition-all duration-200 ease-(--ease-out-expo) hover:bg-accent hover:text-accent-foreground"
                      style={{
                        width: dialogState.skillsOpen ? "auto" : 28,
                        paddingLeft: dialogState.skillsOpen ? 8 : 0,
                        paddingRight: dialogState.skillsOpen ? 8 : 0,
                        gap: dialogState.skillsOpen ? 4 : 0,
                      }}
                      onPointerDown={(e) => {
                        e.stopPropagation();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                        handleAddConnection();
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.stopPropagation();
                          e.preventDefault();
                          handleAddConnection();
                        }
                      }}
                    >
                      <Plus size={14} className="shrink-0" />
                      <span
                        className="overflow-hidden whitespace-nowrap transition-all duration-200 ease-(--ease-out-expo)"
                        style={{
                          width: dialogState.skillsOpen ? "auto" : 0,
                          opacity: dialogState.skillsOpen ? 1 : 0,
                        }}
                      >
                        Add
                      </span>
                    </div>
                    {/* Chevron - expands when open, pushing plus left */}
                    <div
                      className="h-7 inline-flex items-center justify-center overflow-hidden transition-all duration-200 ease-(--ease-out-expo)"
                      style={{
                        width: dialogState.skillsOpen ? 28 : 0,
                        opacity: dialogState.skillsOpen ? 1 : 0,
                      }}
                    >
                      <ChevronUp size={16} className="shrink-0" />
                    </div>
                  </div>
                </button>
              </CollapsibleTrigger>
            )}

            {/* Animated content - using grid-rows for smooth height animation */}
            <div
              className="grid overflow-hidden transition-[grid-template-rows] duration-200 ease-(--ease-out-expo)"
              style={{
                gridTemplateRows: dialogState.skillsOpen ? "1fr" : "0fr",
              }}
            >
              <div className="min-h-0 overflow-hidden">
                <div className="overflow-y-auto max-h-[300px] mask-[linear-gradient(to_bottom,black_calc(100%-40px),transparent_100%)]">
                  <div className="flex flex-col gap-2 px-6 pb-4 pt-2">
                    {connections.map((conn) => (
                      <Suspense
                        key={conn.connection_id}
                        fallback={<SkillItem.Fallback />}
                      >
                        <SkillItem
                          connection_id={conn.connection_id}
                          selected_tools={conn.selected_tools}
                          selected_resources={conn.selected_resources}
                          selected_prompts={conn.selected_prompts}
                          onClick={() =>
                            handleEditConnection(conn.connection_id)
                          }
                        />
                      </Suspense>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </Collapsible>

          {/* Instructions section */}
          <div className="flex flex-col flex-1 p-6 border-t border-border overflow-auto">
            <p className="text-sm font-medium text-muted-foreground mb-2">
              Instructions
            </p>
            <Controller
              name="metadata.instructions"
              control={form.control}
              render={({ field }) => (
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  placeholder="Write instructions here..."
                  className="min-h-[200px] resize-none text-sm placeholder:text-muted-foreground/50 leading-relaxed border-0 rounded-none shadow-none px-0 focus-visible:ring-0 focus-visible:ring-offset-0 focus:border-0 bg-transparent"
                />
              )}
            />
          </div>
        </div>
      </div>

      {/* Dialogs */}
      <DependencySelectionDialog
        open={dialogState.connectionDialogOpen}
        onOpenChange={(open) =>
          dispatch({ type: "SET_CONNECTION_DIALOG_OPEN", payload: open })
        }
        selectedId={dialogState.editingConnectionId}
        form={form}
        connections={connections}
      />

      <VirtualMCPShareModal
        open={dialogState.shareDialogOpen}
        onOpenChange={(open) =>
          dispatch({ type: "SET_SHARE_DIALOG_OPEN", payload: open })
        }
        virtualMcp={virtualMcp}
      />
    </ViewLayout>
  );
}

function VirtualMcpDetailViewContent() {
  const navigate = useNavigate();
  const params = useParams({ from: "/shell/$org/$project/agents/$agentId" });
  const { org, agentId: virtualMcpId } = params;

  const virtualMcp = useVirtualMCP(virtualMcpId);

  if (!virtualMcp) {
    return (
      <div className="flex h-full w-full bg-background">
        <EmptyState
          title="Agent not found"
          description="This Agent may have been deleted or you may not have access."
          actions={
            <Button
              variant="outline"
              onClick={() =>
                navigate({
                  to: "/$org/$project/agents",
                  params: { org, project: ORG_ADMIN_PROJECT_SLUG },
                })
              }
            >
              Back to agents
            </Button>
          }
        />
      </div>
    );
  }

  return <VirtualMcpDetailViewWithData virtualMcp={virtualMcp} />;
}

export default function VirtualMcpDetail() {
  return (
    <ErrorBoundary>
      <Suspense
        fallback={
          <div className="flex h-full items-center justify-center bg-background">
            <Loading01
              size={32}
              className="animate-spin text-muted-foreground"
            />
          </div>
        }
      >
        <VirtualMcpDetailViewContent />
      </Suspense>
    </ErrorBoundary>
  );
}
