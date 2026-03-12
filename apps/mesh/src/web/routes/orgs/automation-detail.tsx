/**
 * Automation Detail Page
 *
 * Settings and run history for a single automation on one page.
 */

import { EmptyState } from "@/web/components/empty-state.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { ViewActions, ViewLayout } from "@/web/components/details/layout";
import { SaveActions } from "@/web/components/save-actions";
import {
  ModelSelector,
  type ModelChangePayload,
  type SelectedModelState,
} from "@/web/components/chat/select-model.tsx";
import { VirtualMCPPopoverContent } from "@/web/components/chat/select-virtual-mcp.tsx";
import {
  useAutomationDetail,
  useAutomationUpdate,
  useAutomationDelete,
  useAutomationTriggerAdd,
  useAutomationTriggerRemove,
  useAutomationRun,
  type AutomationTrigger,
} from "@/web/hooks/use-automations";
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
import {
  ORG_ADMIN_PROJECT_SLUG,
  useProjectContext,
  useVirtualMCPs,
} from "@decocms/mesh-sdk";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Edit05,
  Loading01,
  Play,
  Plus,
  SearchMd,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
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
  model_connection_id: string;
  model_id: string;
}

// ============================================================================
// Add Trigger Popover
// ============================================================================

const CRON_PRESETS = [
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
      await removeTrigger.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "cron",
        cron_expression: trimmed,
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
          {trigger.next_run_at
            ? new Date(trigger.next_run_at).toLocaleString()
            : "-"}
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
  const virtualMcps = useVirtualMCPs();

  const [agentPopoverOpen, setAgentPopoverOpen] = useState(false);

  const initialTiptapDoc =
    (automation.messages?.[0] as { metadata?: Metadata } | undefined)?.metadata
      ?.tiptapDoc ?? undefined;
  const [tiptapDoc, setTiptapDoc] =
    useState<Metadata["tiptapDoc"]>(initialTiptapDoc);
  const [savedDoc] = useState(initialTiptapDoc);

  const form = useForm<SettingsFormData>({
    defaultValues: {
      name: automation.name,
      active: automation.active,
      agent_id: automation.agent?.id ?? "",
      model_connection_id: automation.models?.connectionId ?? "",
      model_id: automation.models?.thinking?.id ?? "",
    },
  });

  const watchAgentId = form.watch("agent_id");
  const watchConnectionId = form.watch("model_connection_id");
  const watchModelId = form.watch("model_id");

  const selectedAgent = virtualMcps.find((v) => v.id === watchAgentId);

  const handleSave = async () => {
    const values = form.getValues();
    try {
      await updateMutation.mutateAsync({
        id: automationId,
        name: values.name,
        active: values.active,
        agent: {
          id: values.agent_id,
          mode: "passthrough",
        },
        models: {
          connectionId: values.model_connection_id,
          thinking: { id: values.model_id },
        },
        messages: tiptapDocToMessages(tiptapDoc),
        temperature: 0,
        tool_approval_level: "none",
      });
      form.reset(values);
      toast.success("Automation saved");
    } catch {
      toast.error("Failed to save automation");
    }
  };

  const handleUndo = () => {
    form.reset();
    setTiptapDoc(savedDoc);
  };

  const handleModelChange = (payload: ModelChangePayload) => {
    form.setValue("model_connection_id", payload.connectionId, {
      shouldDirty: true,
    });
    form.setValue("model_id", payload.id, { shouldDirty: true });
  };

  const selectedModel: SelectedModelState | undefined =
    watchConnectionId && watchModelId
      ? { connectionId: watchConnectionId, thinking: { id: watchModelId } }
      : undefined;

  return (
    <>
      <ViewActions>
        <SaveActions
          onSave={handleSave}
          onUndo={handleUndo}
          isDirty={
            form.formState.isDirty ||
            JSON.stringify(tiptapDoc ?? null) !==
              JSON.stringify(savedDoc ?? null)
          }
          isSaving={updateMutation.isPending}
        />
      </ViewActions>

      <div className="flex flex-col gap-6 p-6">
        {/* Name + Active + Agent + Model — single row */}
        <div className="flex items-center gap-3">
          <Input
            {...form.register("name")}
            placeholder="Automation name"
            className="flex-1 max-w-xs"
          />

          <Controller
            control={form.control}
            name="active"
            render={({ field }) => (
              <Switch checked={field.value} onCheckedChange={field.onChange} />
            )}
          />

          <Popover open={agentPopoverOpen} onOpenChange={setAgentPopoverOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="text-sm hover:bg-accent rounded-lg py-0.5 px-1 gap-1 shadow-none cursor-pointer border-0 group focus-visible:ring-0 focus-visible:ring-offset-0 min-w-0 shrink justify-start overflow-hidden"
              >
                {selectedAgent ? (
                  <>
                    <IntegrationIcon
                      icon={selectedAgent.icon}
                      name={selectedAgent.title}
                      size="xs"
                      className="rounded shrink-0"
                    />
                    <span className="truncate max-w-[120px]">
                      {selectedAgent.title}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">Agent...</span>
                )}
                <ChevronDown size={14} className="text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              className="w-[550px] p-0 overflow-hidden"
              align="start"
            >
              <VirtualMCPPopoverContent
                virtualMcps={virtualMcps}
                selectedVirtualMcpId={watchAgentId || null}
                onVirtualMcpChange={(id) => {
                  form.setValue("agent_id", id ?? "", { shouldDirty: true });
                  setAgentPopoverOpen(false);
                }}
              />
            </PopoverContent>
          </Popover>

          <ModelSelector
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            variant="bordered"
          />
        </div>

        {/* Messages Editor */}
        <TiptapProvider
          tiptapDoc={tiptapDoc}
          setTiptapDoc={setTiptapDoc}
          placeholder="What should this automation do?"
        >
          <div className="rounded-lg border border-border min-h-[120px] flex flex-col">
            <TiptapInput virtualMcpId={watchAgentId || null} />
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
          <RunHistorySection automationId={automationId} />
        </div>
      </div>
    </>
  );
}

// ============================================================================
// Run History Section
// ============================================================================

function RunHistorySection(_props: { automationId: string }) {
  return (
    <EmptyState
      title="No run history"
      description="Run history will appear here when the automation has been triggered."
    />
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
  const runMutation = useAutomationRun();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleRun = async () => {
    try {
      const result = await runMutation.mutateAsync(automationId);
      if (result.skipped) {
        toast.info(`Run skipped: ${result.skipped}`);
      } else if (result.error) {
        toast.error(`Run failed: ${result.error}`);
      } else {
        toast.success("Automation run started");
      }
    } catch {
      toast.error("Failed to run automation");
    }
  };

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
          className="h-7"
          onClick={handleRun}
          disabled={runMutation.isPending}
        >
          {runMutation.isPending ? (
            <Loading01 size={14} className="animate-spin" />
          ) : (
            <Play size={14} />
          )}
          Run Now
        </Button>
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

      <SettingsTab automationId={automationId} automation={automation} />

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
