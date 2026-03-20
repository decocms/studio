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
import { VirtualMCPPopoverContent } from "@/web/components/chat/select-virtual-mcp.tsx";
import { IntegrationIcon } from "@/web/components/integration-icon.tsx";
import { User } from "@/web/components/user/user.tsx";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@deco/ui/components/dropdown-menu.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { getDecopilotId, useProjectContext } from "@decocms/mesh-sdk";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowUp,
  Clock,
  Edit01,
  Loading01,
  Plus,
  Stars01,
  Trash01,
  Users03,
  XClose,
} from "@untitledui/icons";
import { useRef, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useVirtualMCPs,
  isDecopilot,
} from "@decocms/mesh-sdk";
import { KEYS } from "@/web/lib/query-keys.ts";
import { STATUS_CONFIG } from "@/web/lib/task-status.ts";
import { useDecopilotEvents } from "@/web/hooks/use-decopilot-events.ts";
import type { Metadata } from "@/web/components/chat/types.ts";
import {
  TiptapProvider,
  TiptapInput,
} from "@/web/components/chat/tiptap/input.tsx";
import {
  derivePartsFromTiptapDoc,
  tiptapDocToMessages,
} from "@/web/components/chat/derive-parts.ts";
import { chatStore } from "@/web/components/chat/store/chat-store";

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
// Helpers
// ============================================================================

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[\d*/,\-]+$/.test(p));
}

function humanReadableCron(expr: string): string {
  if (!expr) return "Unknown schedule";
  const e = expr.trim();

  // Exact matches
  if (e === "* * * * *") return "Every minute";
  if (e === "0 * * * *") return "Every hour";
  if (e === "0 0 * * *") return "Every day";
  if (e === "0 0 * * 1") return "Every week";

  // Every N minutes: */N * * * *
  const everyNMin = e.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (everyNMin) return `Every ${everyNMin[1]} minutes`;

  // Every N hours: 0 */N * * *
  const everyNHr = e.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (everyNHr) return `Every ${everyNHr[1]} hours`;

  // Every N days (or N*7 days = weeks): 0 0 */N * *
  const everyNDay = e.match(/^0\s+0\s+\*\/(\d+)\s+\*\s+\*$/);
  if (everyNDay) {
    const n = parseInt(everyNDay[1] ?? "1");
    if (n % 7 === 0) return `Every ${n / 7} weeks`;
    return `Every ${n} days`;
  }

  // Daily at specific time: M H * * *
  const dailyMatch = e.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+\*$/);
  if (dailyMatch) {
    const h = (dailyMatch[2] ?? "0").padStart(2, "0");
    const m = (dailyMatch[1] ?? "0").padStart(2, "0");
    return `Every day at ${h}:${m} UTC`;
  }

  // Weekly at specific time: M H * * DOW
  const weeklyMatch = e.match(/^(\d+)\s+(\d+)\s+\*\s+\*\s+(\d)$/);
  if (weeklyMatch) {
    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const dayName = days[parseInt(weeklyMatch[3] ?? "0")] ?? "day";
    const h = (weeklyMatch[2] ?? "0").padStart(2, "0");
    const m = (weeklyMatch[1] ?? "0").padStart(2, "0");
    return `Every ${dayName} at ${h}:${m} UTC`;
  }

  return expr;
}

type TimeUnit = "minutes" | "hours" | "days" | "weeks";

function buildCronFromInterval(count: number, unit: TimeUnit): string {
  const n = Math.max(1, count);
  switch (unit) {
    case "minutes":
      return n === 1 ? "* * * * *" : `*/${n} * * * *`;
    case "hours":
      return n === 1 ? "0 * * * *" : `0 */${n} * * *`;
    case "days":
      return n === 1 ? "0 0 * * *" : `0 0 */${n} * *`;
    case "weeks":
      return n === 1 ? "0 0 * * 1" : `0 0 */${n * 7} * *`;
  }
}

function parseCronToInterval(
  expr: string,
): { count: number; unit: TimeUnit } | null {
  const e = expr.trim();
  if (e === "* * * * *") return { count: 1, unit: "minutes" };
  if (e === "0 * * * *") return { count: 1, unit: "hours" };
  if (e === "0 0 * * *") return { count: 1, unit: "days" };
  if (e === "0 0 * * 1") return { count: 1, unit: "weeks" };
  const m = e.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (m) return { count: parseInt(m[1]!), unit: "minutes" };
  const h = e.match(/^0\s+\*\/(\d+)\s+\*\s+\*\s+\*$/);
  if (h) return { count: parseInt(h[1]!), unit: "hours" };
  const d = e.match(/^0\s+0\s+\*\/(\d+)\s+\*\s+\*$/);
  if (d) {
    const n = parseInt(d[1]!);
    if (n % 7 === 0) return { count: n / 7, unit: "weeks" };
    return { count: n, unit: "days" };
  }
  return null;
}

function unitLabel(unit: TimeUnit, count: number): string {
  const singular: Record<TimeUnit, string> = {
    minutes: "minute",
    hours: "hour",
    days: "day",
    weeks: "week",
  };
  return count === 1 ? (singular[unit] ?? unit) : unit;
}

// ============================================================================
// Add Starter Popover
// ============================================================================

const SCHEDULE_UNITS = [
  { label: "Minute", cron: "* * * * *" },
  { label: "Hour", cron: "0 * * * *" },
  { label: "Day", cron: "0 0 * * *" },
  { label: "Week", cron: "0 0 * * 1" },
] as const;

function AddStarterPopover({
  automationId,
  open,
  onOpenChange,
  onCustomSelect,
}: {
  automationId: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onCustomSelect?: () => void;
}) {
  const addTrigger = useAutomationTriggerAdd();
  const [internalOpen, setInternalOpen] = useState(false);

  const isOpen = open ?? internalOpen;

  const handleOpenChange = (newOpen: boolean) => {
    onOpenChange ? onOpenChange(newOpen) : setInternalOpen(newOpen);
  };

  const submitCron = async (cron: string) => {
    try {
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "cron",
        cron_expression: cron,
      });
      toast.success("Starter added");
      handleOpenChange(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to add starter";
      toast.error(message);
    }
  };

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus size={14} />
          Add Starter
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2.5">
            <Clock size={14} className="text-muted-foreground shrink-0" />
            Every...
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[160px]">
            {SCHEDULE_UNITS.map((unit) => (
              <DropdownMenuItem
                key={unit.cron}
                className="gap-2.5"
                onSelect={() => submitCron(unit.cron)}
                disabled={addTrigger.isPending}
              >
                <Clock size={14} className="text-muted-foreground shrink-0" />
                Every {unit.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuItem
          className="gap-2.5"
          onSelect={() => {
            handleOpenChange(false);
            onCustomSelect?.();
          }}
        >
          <Clock size={14} className="text-muted-foreground shrink-0" />
          Custom (cron)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ============================================================================
// Trigger Card
// ============================================================================

function TriggerCard({
  trigger,
  automationId,
}: {
  trigger: AutomationTrigger;
  automationId: string;
}) {
  const removeTrigger = useAutomationTriggerRemove();
  const addTrigger = useAutomationTriggerAdd();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const interval = trigger.cron_expression
    ? parseCronToInterval(trigger.cron_expression)
    : null;
  const [count, setCount] = useState(interval?.count ?? 1);
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(trigger.cron_expression ?? "");

  const isSaving = removeTrigger.isPending || addTrigger.isPending;
  const isCron = trigger.type === "cron";

  const handleRemove = async () => {
    try {
      await removeTrigger.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
      toast.success("Starter removed");
    } catch {
      toast.error("Failed to remove starter");
    }
    setConfirmDelete(false);
  };

  const handleEditSave = async () => {
    const val = editValue.trim();
    if (!val || !isValidCron(val) || val === trigger.cron_expression) {
      setIsEditing(false);
      setEditValue(trigger.cron_expression ?? "");
      return;
    }
    try {
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "cron",
        cron_expression: val,
      });
      await removeTrigger.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
      setIsEditing(false);
    } catch {
      toast.error("Failed to update starter");
      setEditValue(trigger.cron_expression ?? "");
      setIsEditing(false);
    }
  };

  const handleCountSave = async (newCount: number) => {
    if (!interval) return;
    const clamped = Math.max(1, newCount);
    const newCron = buildCronFromInterval(clamped, interval.unit);
    if (newCron === trigger.cron_expression) return;
    try {
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "cron",
        cron_expression: newCron,
      });
      await removeTrigger.mutateAsync({
        trigger_id: trigger.id,
        automation_id: automationId,
      });
    } catch {
      toast.error("Failed to update starter");
      setCount(interval.count);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border bg-background group">
        <Clock size={14} className="text-muted-foreground shrink-0" />

        {interval && isCron ? (
          <>
            <span className="text-sm text-muted-foreground">Every</span>
            <input
              type="number"
              min={1}
              value={count}
              onChange={(e) => setCount(parseInt(e.target.value) || 1)}
              onBlur={() => handleCountSave(count)}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") setCount(interval.count);
              }}
              disabled={isSaving}
              className="w-12 text-center text-sm h-7 border border-border rounded-md bg-background px-1 focus:outline-none focus:ring-1 focus:ring-ring"
            />
            <span className="text-sm">{unitLabel(interval.unit, count)}</span>
          </>
        ) : isCron && isEditing ? (
          <>
            <input
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleEditSave}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setIsEditing(false);
                  setEditValue(trigger.cron_expression ?? "");
                }
              }}
              className="flex-1 text-sm font-mono bg-transparent outline-none"
              autoFocus
            />
            {editValue && !isValidCron(editValue) && (
              <span className="text-xs text-muted-foreground/60 shrink-0">
                invalid
              </span>
            )}
          </>
        ) : (
          <span className="text-sm flex-1 font-mono text-xs text-muted-foreground">
            {isCron
              ? humanReadableCron(trigger.cron_expression ?? "")
              : `${trigger.event_type} event`}
          </span>
        )}

        <div className="ml-auto flex items-center gap-1">
          {isSaving && (
            <Loading01
              size={13}
              className="animate-spin text-muted-foreground"
            />
          )}
          {isCron && !interval && !isEditing && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={() => {
                setEditValue(trigger.cron_expression ?? "");
                setIsEditing(true);
              }}
            >
              <Edit01 size={13} className="text-muted-foreground" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => setConfirmDelete(true)}
          >
            <XClose size={13} className="text-muted-foreground" />
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Starter</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove this starter?
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
// Agent Picker
// ============================================================================

function AgentPicker({
  selectedId,
  onChange,
}: {
  selectedId: string | null;
  onChange: (id: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const allVirtualMcps = useVirtualMCPs();
  const virtualMcps = allVirtualMcps.filter((v) => !v.id || !isDecopilot(v.id));
  const selected = selectedId
    ? virtualMcps.find((v) => v.id === selectedId)
    : null;

  if (selected) {
    return (
      <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border bg-background hover:bg-accent/50 transition-colors">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
            >
              <IntegrationIcon
                icon={selected.icon}
                name={selected.title}
                size="sm"
                fallbackIcon={<Users03 size={16} />}
                className="rounded-md shrink-0"
              />
              <span className="text-sm font-medium truncate">
                {selected.title}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            className="w-[550px] p-0 overflow-hidden"
            align="start"
            sideOffset={8}
          >
            <VirtualMCPPopoverContent
              virtualMcps={virtualMcps}
              selectedVirtualMcpId={selectedId}
              onVirtualMcpChange={(id) => {
                onChange(id);
                setOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 size-7 text-muted-foreground hover:text-foreground"
          onClick={() => onChange(null)}
          title="Remove agent"
        >
          <XClose size={13} />
        </Button>
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-border hover:bg-accent/50 transition-colors w-full text-left cursor-pointer"
        >
          <div className="relative flex items-center justify-center size-8 rounded-md text-muted-foreground/75 shrink-0">
            <svg className="absolute inset-0 size-full" fill="none">
              <defs>
                <linearGradient
                  id="agent-picker-border-gradient"
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
                stroke="url(#agent-picker-border-gradient)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
            </svg>
            <Users03 size={16} />
          </div>
          <span className="text-sm text-muted-foreground">
            No agent selected. All connections available.
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[550px] p-0 overflow-hidden"
        align="start"
        sideOffset={8}
      >
        <VirtualMCPPopoverContent
          virtualMcps={virtualMcps}
          selectedVirtualMcpId={selectedId}
          onVirtualMcpChange={(id) => {
            onChange(id);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
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
  const { org } = useProjectContext();
  const updateMutation = useAutomationUpdate();

  // Chat hooks for running the automation
  const {
    createTask,
    setVirtualMcpId,
    setSelectedModel,
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
  const [starterOpen, setStarterOpen] = useState(false);
  const [showCustomCron, setShowCustomCron] = useState(false);
  const [cronInput, setCronInput] = useState("");
  const addTrigger = useAutomationTriggerAdd();
  const editorInitializedRef = useRef(false);

  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocRaw(doc);
    if (!editorInitializedRef.current) {
      editorInitializedRef.current = true;
      if (!initialTiptapDoc) {
        setSavedDoc(doc);
      }
    }
  };

  const handleImprovePrompt = () => {
    const parts = derivePartsFromTiptapDoc(tiptapDoc);
    const instructionsText = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (!instructionsText.trim()) return;

    setChatOpen(true);

    chatStore.createThreadAndSend({
      parts: [
        {
          type: "text",
          text: `/writing-prompts for automation with id ${automationId}. The current message is\n\n<message>\n${instructionsText}\n</message>`,
        },
      ],
      agent: {
        id: getDecopilotId(org.id),
        title: "Decopilot",
        description: null,
        icon: null,
      },
      toolApprovalLevel: "plan",
    });
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

  const watchActive = form.watch("active");
  const watchAgentId = form.watch("agent_id");
  const watchConnectionId = form.watch("credential_id");
  const watchModelId = form.watch("model_id");

  const { models, isLoading: isModelsLoading } = useAiProviderModels(
    watchConnectionId || undefined,
  );
  const selectedModel: AiProviderModel | null =
    models.find((m) => m.modelId === watchModelId) ?? null;

  const handleSave = async (): Promise<boolean> => {
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
      return true;
    } catch {
      toast.error("Failed to save automation");
      return false;
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
      const saved = await handleSave();
      if (!saved) return;
    }

    if (!tiptapDoc) {
      toast.error("No instructions configured for this automation");
      return;
    }

    const values = form.getValues();

    setVirtualMcpId(values.agent_id || null);
    if (selectedModel && watchConnectionId) {
      setSelectedModel({ ...selectedModel, keyId: watchConnectionId });
    }

    setChatOpen(true);
    createTask();

    setTimeout(() => {
      sendMessage(tiptapDoc, { toolApprovalLevel: "auto" });
    }, 0);
  };

  return (
    <>
      <ViewActions>
        <SaveActions
          onSave={async () => {
            await handleSave();
          }}
          onUndo={handleUndo}
          isDirty={isDirty}
          isSaving={updateMutation.isPending}
        />
      </ViewActions>

      <div className="max-w-2xl mx-auto w-full px-6 py-6 flex flex-col gap-8">
        {/* Header: Name + Status + Creator */}
        <div className="flex flex-col gap-1.5">
          <Input
            {...form.register("name")}
            placeholder="Automation name"
            className="border border-transparent shadow-none px-0 text-2xl md:text-2xl font-semibold h-auto focus-visible:ring-0 focus-visible:border-border bg-transparent"
          />
          <div className="flex items-center gap-2">
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
            <span className="text-sm text-muted-foreground">
              {watchActive ? "Active" : "Inactive"}
            </span>
            <span className="text-muted-foreground/50 text-sm">·</span>
            <User
              id={automation.created_by}
              size="2xs"
              className="text-sm text-muted-foreground"
            />
          </div>
        </div>

        {/* Section: Starter (was Triggers) */}
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground/60">
              Starter
            </span>
            <AddStarterPopover
              automationId={automationId}
              open={starterOpen}
              onOpenChange={setStarterOpen}
              onCustomSelect={() => {
                setShowCustomCron(true);
                setCronInput("");
              }}
            />
          </div>

          {automation.triggers.length === 0 && !showCustomCron ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">
                When should this automation run?{" "}
                <button
                  type="button"
                  className="text-foreground underline underline-offset-2 cursor-pointer hover:text-foreground/80 transition-colors"
                  onClick={() => setStarterOpen(true)}
                >
                  Add a starter
                </button>{" "}
                to get going.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {automation.triggers.map((trigger) => (
                <TriggerCard
                  key={trigger.id}
                  trigger={trigger}
                  automationId={automationId}
                />
              ))}
            </div>
          )}

          {showCustomCron && (
            <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-border bg-background group">
              <Clock size={14} className="text-muted-foreground shrink-0" />
              <input
                type="text"
                value={cronInput}
                onChange={(e) => setCronInput(e.target.value)}
                onBlur={async () => {
                  const val = cronInput.trim();
                  if (!val || !isValidCron(val)) return;
                  try {
                    await addTrigger.mutateAsync({
                      automation_id: automationId,
                      type: "cron",
                      cron_expression: val,
                    });
                    toast.success("Starter added");
                    setShowCustomCron(false);
                    setCronInput("");
                  } catch {
                    toast.error("Failed to add starter");
                  }
                }}
                onKeyDown={async (e) => {
                  const val = cronInput.trim();
                  if (e.key === "Enter" && val && isValidCron(val)) {
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === "Escape") {
                    setShowCustomCron(false);
                    setCronInput("");
                  }
                }}
                placeholder="0 9 * * 1-5"
                className="flex-1 text-sm font-mono bg-transparent outline-none placeholder:text-muted-foreground/40"
                autoFocus
              />
              {cronInput && !isValidCron(cronInput) && (
                <span className="text-xs text-muted-foreground/60 shrink-0">
                  invalid
                </span>
              )}
              {addTrigger.isPending && (
                <Loading01
                  size={13}
                  className="animate-spin text-muted-foreground shrink-0"
                />
              )}
              <button
                type="button"
                className="shrink-0 p-0.5 rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:text-foreground transition-opacity"
                onClick={() => {
                  setShowCustomCron(false);
                  setCronInput("");
                }}
              >
                <XClose size={13} />
              </button>
            </div>
          )}
        </div>

        {/* Section: Agent */}
        <div className="flex flex-col gap-2.5">
          <span className="text-xs font-semibold text-muted-foreground/60">
            Agent
          </span>
          <AgentPicker
            selectedId={watchAgentId || null}
            onChange={(id) =>
              form.setValue("agent_id", id ?? "", { shouldDirty: true })
            }
          />
        </div>

        {/* Section: Instructions */}
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground/60">
              Instructions
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={!tiptapDoc}
              onClick={handleImprovePrompt}
            >
              <Stars01 size={13} />
              Improve
            </Button>
          </div>
          <TiptapProvider
            tiptapDoc={tiptapDoc}
            setTiptapDoc={setTiptapDoc}
            placeholder="What should this automation do?"
          >
            <div className="rounded-xl border border-border min-h-[120px] flex flex-col">
              <TiptapInput virtualMcpId={watchAgentId || null} />

              <div className="flex items-center justify-end gap-1.5 p-2.5">
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
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="default"
                      className="h-8 gap-1.5 rounded-md px-3 text-sm font-medium"
                      onClick={handleRunClick}
                    >
                      <ArrowUp size={16} />
                      Test
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Test Automation</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </TiptapProvider>
        </div>

        {/* Section: Run History */}
        <div className="flex flex-col gap-2.5">
          <span className="text-xs font-semibold text-muted-foreground/60">
            Run History
          </span>
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

  useDecopilotEvents({
    orgId: org.id,
    enabled: triggerIds.length > 0,
    onTaskStatus: (event) => {
      const threadId = event.subject;
      const cached = runs ?? [];
      const existingRun = cached.find((r) => r.id === threadId);
      if (existingRun) {
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
        image={null}
        className="mt-6"
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
        params: { org: org.slug, project: "org-admin" },
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
              params={{ org: org.slug, project: "org-admin" }}
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
