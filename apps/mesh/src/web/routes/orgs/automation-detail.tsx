/**
 * Automation Detail Page
 *
 * Settings and run history for a single automation on one page.
 */

import { EmptyState } from "@/web/components/empty-state.tsx";
import { ViewActions, ViewLayout } from "@/web/components/details/layout";
import { SaveActions } from "@/web/components/save-actions";
import {
  useAiProviderModels,
  type AiProviderModel,
} from "@/web/hooks/collections/use-llm.ts";
import { ModelSelector } from "@/web/components/chat/select-model.tsx";
import { VirtualMCPSelector } from "@/web/components/chat/select-virtual-mcp.tsx";
import {
  useAutomationDetail,
  useAutomationUpdate,
  useAutomationDelete,
  useAutomationTriggerAdd,
  useAutomationTriggerRemove,
  type AutomationTrigger,
} from "@/web/hooks/use-automations";
import { useChat } from "@/web/components/chat/index";
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@deco/ui/components/alert-dialog.tsx";
import { Badge } from "@deco/ui/components/badge.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@deco/ui/components/breadcrumb.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Table as UITable,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@deco/ui/components/table.tsx";
import { ORG_ADMIN_PROJECT_SLUG, useProjectContext } from "@decocms/mesh-sdk";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUp,
  Check,
  ChevronRight,
  Clock,
  Edit05,
  Loading01,
  Plus,
  SearchMd,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { useRef, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
import { Cron } from "croner";
import { formatDistanceToNow } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SELF_MCP_ALIAS_ID, useMCPClient } from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys.ts";
import { STATUS_CONFIG } from "@/web/lib/task-status.ts";
import { useDecopilotEvents } from "@/web/hooks/use-decopilot-events.ts";
import type { Metadata } from "@/web/components/chat/types.ts";
import {
  TiptapProvider,
  TiptapInput,
} from "@/web/components/chat/tiptap/input.tsx";
import { tiptapDocToMessages } from "@/web/components/chat/derive-parts.ts";

// ============================================================================
// Types
// ============================================================================

interface SettingsFormData {
  name: string;
  active: boolean;
  agent_id: string;
  credential_id: string;
  model_id: string;
}

// ============================================================================
// Add Trigger Popover
// ============================================================================

const CRON_PRESETS = [
  { label: "Minute", cron: "* * * * *" },
  { label: "Hour", cron: "0 * * * *" },
  { label: "Day", cron: "0 0 * * *" },
  { label: "Week", cron: "0 0 * * 1" },
] as const;

type TriggerView = "menu" | "every" | "custom-cron";

function AddTriggerPopover({ automationId }: { automationId: string }) {
  const addTrigger = useAutomationTriggerAdd();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<TriggerView>("menu");
  const [search, setSearch] = useState("");
  const [cronInput, setCronInput] = useState("");

  const resetState = () => {
    setView("menu");
    setSearch("");
    setCronInput("");
  };

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    if (!newOpen) resetState();
  };

  const submitCron = async (cron: string) => {
    try {
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "cron",
        cron_expression: cron,
      });
      toast.success("Trigger added");
      handleOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add trigger";
      toast.error(message);
    }
  };

  const handleCustomSubmit = () => {
    if (!cronInput.trim()) {
      toast.error("Cron expression is required");
      return;
    }
    submitCron(cronInput.trim());
  };

  // Flatten items for search filtering
  const allItems = [
    ...CRON_PRESETS.map((p) => ({
      label: `Every ${p.label}`,
      action: () => submitCron(p.cron),
    })),
    {
      label: "Custom (cron)",
      action: () => setView("custom-cron"),
    },
  ];

  const filteredItems = search.trim()
    ? allItems.filter((item) =>
        item.label.toLowerCase().includes(search.toLowerCase()),
      )
    : null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus size={14} />
          Add Trigger
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="end">
        {/* Search (always visible) */}
        <div className="border-b px-3 py-2">
          <div className="relative flex items-center gap-2">
            <SearchMd
              size={14}
              className="text-muted-foreground pointer-events-none shrink-0"
            />
            <input
              type="text"
              placeholder="Search triggers..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="flex-1 text-sm bg-transparent border-0 outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <div className="py-1">
          {filteredItems ? (
            /* Search results */
            filteredItems.length > 0 ? (
              filteredItems.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent cursor-pointer transition-colors"
                  onClick={item.action}
                  disabled={addTrigger.isPending}
                >
                  {item.label}
                </button>
              ))
            ) : (
              <div className="px-3 py-4 text-sm text-muted-foreground text-center">
                No triggers found
              </div>
            )
          ) : view === "menu" ? (
            /* Top-level menu */
            <>
              <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-1.5">
                <Clock size={12} />
                Scheduled
              </div>
              <button
                type="button"
                className="w-full flex items-center justify-between px-3 py-2 text-sm hover:bg-accent cursor-pointer transition-colors"
                onClick={() => setView("every")}
              >
                <span>Every...</span>
                <ChevronRight size={14} className="text-muted-foreground" />
              </button>
              <button
                type="button"
                className="w-full text-left px-3 py-2 text-sm hover:bg-accent cursor-pointer transition-colors"
                onClick={() => setView("custom-cron")}
              >
                Custom (cron)
              </button>
            </>
          ) : view === "every" ? (
            /* Every... submenu */
            <>
              <button
                type="button"
                className="w-full flex items-center gap-1.5 px-3 py-2 text-sm hover:bg-accent cursor-pointer transition-colors text-muted-foreground"
                onClick={() => setView("menu")}
              >
                <ArrowLeft size={14} />
                Back
              </button>
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-accent cursor-pointer transition-colors"
                  onClick={() => submitCron(preset.cron)}
                  disabled={addTrigger.isPending}
                >
                  Every {preset.label}
                </button>
              ))}
            </>
          ) : (
            /* Custom cron input */
            <>
              <button
                type="button"
                className="w-full flex items-center gap-1.5 px-3 py-2 text-sm hover:bg-accent cursor-pointer transition-colors text-muted-foreground"
                onClick={() => setView("menu")}
              >
                <ArrowLeft size={14} />
                Back
              </button>
              <div className="px-3 py-2 flex flex-col gap-2">
                <Input
                  value={cronInput}
                  onChange={(e) => setCronInput(e.target.value)}
                  placeholder="*/5 * * * *"
                  className="h-8 text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Minimum interval: 60 seconds between runs.
                </p>
                <Button
                  size="sm"
                  className="w-full"
                  onClick={handleCustomSubmit}
                  disabled={addTrigger.isPending}
                >
                  {addTrigger.isPending && (
                    <Loading01 size={14} className="animate-spin" />
                  )}
                  Add Trigger
                </Button>
              </div>
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ============================================================================
// Trigger Row
// ============================================================================

function TriggerRow({
  trigger,
  automationId,
}: {
  trigger: AutomationTrigger;
  automationId: string;
}) {
  const removeTrigger = useAutomationTriggerRemove();
  const addTrigger = useAutomationTriggerAdd();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(trigger.cron_expression ?? "");

  const isSaving = removeTrigger.isPending || addTrigger.isPending;

  const handleRemove = async () => {
    try {
      await removeTrigger.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
      toast.success("Trigger removed");
    } catch {
      toast.error("Failed to remove trigger");
    }
    setConfirmDelete(false);
  };

  const handleEditSave = async () => {
    const trimmed = editValue.trim();
    if (!trimmed) {
      toast.error("Cron expression is required");
      return;
    }
    if (trimmed === trigger.cron_expression) {
      setEditing(false);
      return;
    }
    try {
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "cron",
        cron_expression: trimmed,
      });
      await removeTrigger.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
      toast.success("Trigger updated");
      setEditing(false);
    } catch {
      toast.error("Failed to update trigger");
    }
  };

  const handleEditCancel = () => {
    setEditValue(trigger.cron_expression ?? "");
    setEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleEditSave();
    if (e.key === "Escape") handleEditCancel();
  };

  const isCron = trigger.type === "cron";

  return (
    <>
      <TableRow>
        <TableCell>
          <Badge variant="outline">{isCron ? "Cron" : "Event"}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground font-mono text-xs">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <Input
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="*/5 * * * *"
                className="h-7 text-xs font-mono w-36"
                autoFocus
                disabled={isSaving}
              />
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={handleEditSave}
                disabled={isSaving}
              >
                {isSaving ? (
                  <Loading01 size={14} className="animate-spin" />
                ) : (
                  <Check size={14} className="text-green-600" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={handleEditCancel}
                disabled={isSaving}
              >
                <XClose size={14} className="text-muted-foreground" />
              </Button>
            </div>
          ) : isCron ? (
            trigger.cron_expression
          ) : (
            `${trigger.event_type} @ ${trigger.connection_id?.slice(0, 8)}...`
          )}
        </TableCell>
        <TableCell className="text-muted-foreground text-xs">
          {(() => {
            if (!isCron || !trigger.cron_expression) return "-";
            try {
              const nextRun = new Cron(trigger.cron_expression, {
                timezone: "UTC",
              }).nextRun();
              return nextRun
                ? nextRun.toLocaleString(undefined, {
                    timeZoneName: "short",
                  })
                : "-";
            } catch {
              return "-";
            }
          })()}
        </TableCell>
        <TableCell>
          <div className="flex items-center gap-0.5">
            {isCron && !editing && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setEditing(true)}
              >
                <Edit05 size={14} className="text-muted-foreground" />
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash01 size={14} className="text-muted-foreground" />
            </Button>
          </div>
        </TableCell>
      </TableRow>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Trigger</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this trigger? For event triggers,
              it will also be disabled on the connection.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleRemove}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ============================================================================
// Settings Tab
// ============================================================================

function SettingsTab({
  automationId,
  automation,
}: {
  automationId: string;
  automation: NonNullable<ReturnType<typeof useAutomationDetail>["data"]>;
}) {
  const updateMutation = useAutomationUpdate();

  // Chat hooks for running the automation
  const {
    createTask,
    setVirtualMcpId,
    setSelectedModel,
    setSelectedMode,
    sendMessage,
    credentialId: chatCredentialId,
    model: chatModel,
  } = useChat();
  const [, setChatOpen] = useDecoChatOpen();

  const initialTiptapDoc =
    (automation.messages?.[0] as { metadata?: Metadata } | undefined)?.metadata
      ?.tiptapDoc ?? undefined;
  const [tiptapDoc, setTiptapDocRaw] =
    useState<Metadata["tiptapDoc"]>(initialTiptapDoc);
  const [savedDoc, setSavedDoc] = useState(initialTiptapDoc);
  const editorInitializedRef = useRef(false);

  // Sync savedDoc on the first editor-triggered update so the editor's
  // initialisation doesn't mark the form as dirty.
  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocRaw(doc);
    if (!editorInitializedRef.current) {
      editorInitializedRef.current = true;
      if (!initialTiptapDoc) {
        setSavedDoc(doc);
      }
    }
  };

  const defaultCredentialId =
    automation.models?.credentialId || chatCredentialId || "";
  const defaultModelId =
    automation.models?.thinking?.id || chatModel?.modelId || "";

  const form = useForm<SettingsFormData>({
    defaultValues: {
      name: automation.name,
      active: automation.active,
      agent_id: automation.agent?.id ?? "",
      credential_id: defaultCredentialId,
      model_id: defaultModelId,
    },
  });

  const watchAgentId = form.watch("agent_id");
  const watchConnectionId = form.watch("credential_id");
  const watchModelId = form.watch("model_id");

  const { models, isLoading: isModelsLoading } = useAiProviderModels(
    watchConnectionId || undefined,
  );
  const selectedModel: AiProviderModel | null =
    models.find((m) => m.modelId === watchModelId) ?? null;

  const handleSave = async () => {
    const values = form.getValues();
    try {
      const coercedCredentialId =
        values.credential_id && values.model_id ? values.credential_id : "";
      const coercedModelId =
        values.credential_id && values.model_id ? values.model_id : "";

      await updateMutation.mutateAsync({
        id: automationId,
        name: values.name,
        active: values.active,
        agent: {
          id: values.agent_id,
          mode: "passthrough",
        },
        models: {
          credentialId: coercedCredentialId,
          thinking: {
            id: coercedModelId,
          },
        },
        messages: tiptapDocToMessages(tiptapDoc),
        temperature: 0,
      });
      form.reset({
        ...values,
        credential_id: coercedCredentialId,
        model_id: coercedModelId,
      });
      setSavedDoc(tiptapDoc);
      toast.success("Automation saved");
    } catch {
      toast.error("Failed to save automation");
    }
  };

  const handleUndo = () => {
    form.reset();
    setTiptapDoc(savedDoc);
  };

  const isDirty =
    form.formState.isDirty ||
    JSON.stringify(tiptapDoc ?? null) !== JSON.stringify(savedDoc ?? null);

  const handleRunClick = async () => {
    if (isDirty) {
      await handleSave();
    }

    if (!tiptapDoc) {
      toast.error("No message configured for this automation");
      return;
    }

    const values = form.getValues();

    // Set agent and model to match current form values
    setVirtualMcpId(values.agent_id || null);
    setSelectedMode("passthrough");
    if (selectedModel) {
      setSelectedModel(selectedModel);
    }

    // Open chat and create a new thread
    setChatOpen(true);
    createTask();

    // Send message after React flushes the new thread state
    setTimeout(() => {
      sendMessage(tiptapDoc);
    }, 0);
  };

  return (
    <>
      <ViewActions>
        <SaveActions
          onSave={handleSave}
          onUndo={handleUndo}
          isDirty={isDirty}
          isSaving={updateMutation.isPending}
        />
      </ViewActions>

      <div className="flex flex-col gap-6 p-6">
        {/* Name + Active */}
        <div className="flex items-center justify-between gap-3">
          <Input
            {...form.register("name")}
            placeholder="Automation name"
            className="flex-1 max-w-xs"
          />

          <Controller
            control={form.control}
            name="active"
            render={({ field }) => (
              <Switch
                checked={field.value}
                onCheckedChange={field.onChange}
                className="cursor-pointer"
              />
            )}
          />
        </div>

        {/* Messages Editor with bottom actions (mirrors chat input layout) */}
        <TiptapProvider
          tiptapDoc={tiptapDoc}
          setTiptapDoc={setTiptapDoc}
          placeholder="What should this automation do?"
        >
          <div className="rounded-xl border border-border min-h-[120px] flex flex-col">
            <TiptapInput virtualMcpId={watchAgentId || null} />

            {/* Bottom Actions Row */}
            <div className="flex items-center justify-between p-2.5">
              {/* Left: Agent selector */}
              <div className="flex items-center gap-1.5 min-w-0 overflow-hidden">
                <VirtualMCPSelector
                  selectedVirtualMcpId={watchAgentId || null}
                  onVirtualMcpChange={(id) =>
                    form.setValue("agent_id", id ?? "", { shouldDirty: true })
                  }
                  placeholder="Select Agent"
                />
              </div>

              {/* Right: Model selector + Run button */}
              <div className="flex items-center gap-1.5">
                <ModelSelector
                  model={selectedModel}
                  isLoading={isModelsLoading}
                  credentialId={watchConnectionId || null}
                  onCredentialChange={(id) => {
                    form.setValue("credential_id", id ?? "", {
                      shouldDirty: true,
                    });
                    form.setValue("model_id", "", { shouldDirty: true });
                  }}
                  onModelChange={(model) =>
                    form.setValue("model_id", model.modelId, {
                      shouldDirty: true,
                    })
                  }
                  placeholder="Model"
                />
                <Button
                  type="button"
                  variant="default"
                  size="icon"
                  className="size-8 rounded-full"
                  onClick={handleRunClick}
                  title="Test Automation"
                >
                  <ArrowUp size={20} />
                </Button>
              </div>
            </div>
          </div>
        </TiptapProvider>

        {/* Triggers Section */}
        <div className="flex flex-col gap-3 border-t border-border pt-6">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Triggers</h3>
            <AddTriggerPopover automationId={automationId} />
          </div>

          {automation.triggers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">
              No triggers configured. Add a cron schedule or event trigger.
            </p>
          ) : (
            <UITable>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Configuration</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {automation.triggers.map((trigger) => (
                  <TriggerRow
                    key={trigger.id}
                    trigger={trigger}
                    automationId={automationId}
                  />
                ))}
              </TableBody>
            </UITable>
          )}
        </div>
        {/* Run History */}
        <div className="flex flex-col gap-3 border-t border-border pt-6">
          <h3 className="text-sm font-medium">Run History</h3>
          <RunHistorySection
            automationId={automationId}
            triggerIds={automation.triggers.map((t) => t.id)}
          />
        </div>
      </div>
    </>
  );
}

// ============================================================================
// Run History Section
// ============================================================================

interface RunThread {
  id: string;
  title: string;
  status: string;
  updated_at: string;
}

function useAutomationRuns(
  orgId: string,
  automationId: string,
  triggerIds: string[],
) {
  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId,
  });

  return useQuery({
    queryKey: KEYS.automationRuns(orgId, automationId, triggerIds),
    queryFn: async () => {
      if (!client) throw new Error("MCP client not available");
      const result = (await client.callTool({
        name: "COLLECTION_THREADS_LIST",
        arguments: { where: { trigger_ids: triggerIds }, limit: 20 },
      })) as { structuredContent?: unknown };
      const payload = (result.structuredContent ?? result) as {
        items: RunThread[];
        totalCount: number;
      };
      return payload.items ?? [];
    },
    enabled: triggerIds.length > 0,
  });
}

function RunHistorySection({
  automationId,
  triggerIds,
}: {
  automationId: string;
  triggerIds: string[];
}) {
  const { org } = useProjectContext();
  const { switchToTask } = useChat();
  const [, setChatOpen] = useDecoChatOpen();
  const queryClient = useQueryClient();
  const { data: runs, isLoading } = useAutomationRuns(
    org.id,
    automationId,
    triggerIds,
  );

  // Real-time updates via SSE
  useDecopilotEvents({
    orgId: org.id,
    enabled: triggerIds.length > 0,
    onTaskStatus: (event) => {
      const threadId = event.subject;
      const cached = runs ?? [];
      const existingRun = cached.find((r) => r.id === threadId);
      if (existingRun) {
        // Update status in cache
        queryClient.setQueryData(
          KEYS.automationRuns(org.id, automationId, triggerIds),
          cached.map((r) =>
            r.id === threadId
              ? {
                  ...r,
                  status: event.data.status,
                  updated_at: new Date().toISOString(),
                }
              : r,
          ),
        );
      } else {
        // New run — refetch to pick it up
        queryClient.invalidateQueries({
          queryKey: KEYS.automationRuns(org.id, automationId, triggerIds),
        });
      }
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loading01 size={18} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!runs || runs.length === 0) {
    return (
      <EmptyState
        title="No run history"
        description="Run history will appear here when the automation has been triggered."
      />
    );
  }

  const handleRunClick = async (threadId: string) => {
    await switchToTask(threadId);
    setChatOpen(true);
  };

  return (
    <div className="flex flex-col divide-y divide-border">
      {runs.map((run) => {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        const config = (STATUS_CONFIG[run.status] ?? STATUS_CONFIG.completed)!;
        const StatusIcon = config.icon;
        return (
          <button
            key={run.id}
            type="button"
            className="flex items-center gap-3 px-1 py-2.5 text-left hover:bg-accent/50 transition-colors cursor-pointer rounded-sm"
            onClick={() => handleRunClick(run.id)}
          >
            <StatusIcon size={16} className={config.iconClassName} />
            <span className="flex-1 min-w-0 text-sm truncate">{run.title}</span>
            <span className="text-xs text-muted-foreground shrink-0">
              {formatDistanceToNow(new Date(run.updated_at), {
                addSuffix: true,
              })}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ============================================================================
// Main Component
// ============================================================================

export default function AutomationDetailPage() {
  const { automationId } = useParams({ strict: false }) as {
    automationId: string;
  };
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const { data: automation, isLoading } = useAutomationDetail(automationId);
  const deleteMutation = useAutomationDelete();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = async () => {
    try {
      await deleteMutation.mutateAsync(automationId);
      toast.success("Automation deleted");
      navigate({
        to: "/$org/$project/automations",
        params: { org: org.slug, project: ORG_ADMIN_PROJECT_SLUG },
      });
    } catch {
      toast.error("Failed to delete automation");
    }
    setConfirmDelete(false);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loading01 size={24} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!automation) {
    return (
      <EmptyState
        title="Automation not found"
        description="This automation may have been deleted."
      />
    );
  }

  const breadcrumb = (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link
              to="/$org/$project/automations"
              params={{ org: org.slug, project: ORG_ADMIN_PROJECT_SLUG }}
            >
              Automations
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{automation.name}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  return (
    <ViewLayout breadcrumb={breadcrumb}>
      <ViewActions>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 text-destructive hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash01 size={14} />
          Delete
        </Button>
      </ViewActions>

      <SettingsTab
        key={automationId}
        automationId={automationId}
        automation={automation}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Automation</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &quot;{automation.name}&quot;?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ViewLayout>
  );
}
