/**
 * Automation Detail Page
 *
 * Settings and run history for a single automation on one page.
 */

import {
  useAiProviderModels,
  type AiProviderModel,
} from "@/web/hooks/collections/use-ai-providers.ts";
import { ModelSelector } from "@/web/components/chat/select-model.tsx";
import { User } from "@/web/components/user/user.tsx";
import {
  useAutomationDetail,
  useAutomationUpdate,
  useAutomationTriggerAdd,
  useTriggerList,
  type TriggerDefinition,
} from "@/web/hooks/use-automations";
import { useChatTask, useChatPrefs } from "@/web/components/chat/context";
import { usePreferences } from "@/web/hooks/use-preferences";
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import {
  getDecopilotId,
  useConnections,
  useProjectContext,
} from "@decocms/mesh-sdk";
import {
  ArrowLeft,
  ArrowUp,
  Clock,
  Loading01,
  Stars01,
  Trash01,
  XClose,
  Zap,
} from "@untitledui/icons";
import { Suspense, useRef, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { toast } from "sonner";
import type { Metadata } from "@/web/components/chat/types.ts";
import {
  TiptapProvider,
  TiptapInput,
} from "@/web/components/chat/tiptap/input.tsx";
import {
  derivePartsFromTiptapDoc,
  tiptapDocToMessages,
} from "@/web/components/chat/derive-parts.ts";

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
// Helpers (shared)
// ============================================================================

import { isValidCron } from "@/web/lib/cron-utils.ts";
import { AddStarterPopover } from "@/web/components/automations/add-starter-popover.tsx";
import { TriggerCard } from "@/web/components/automations/trigger-card.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@deco/ui/components/select.tsx";

// ============================================================================
// Event Trigger Form
// ============================================================================

function EventTriggerForm({
  automationId,
  onDone,
}: {
  automationId: string;
  onDone: () => void;
}) {
  const triggerConnections = useConnections({ binding: "TRIGGER" });
  const [connectionId, setConnectionId] = useState<string | undefined>();
  const [eventType, setEventType] = useState<string | undefined>();
  const [params, setParams] = useState<Record<string, string>>({});
  const addTrigger = useAutomationTriggerAdd();
  const { data: triggerDefs, isLoading: isLoadingTriggers } =
    useTriggerList(connectionId);

  const selectedTrigger = triggerDefs?.find(
    (t: TriggerDefinition) => t.type === eventType,
  );

  const handleSubmit = async () => {
    if (!connectionId || !eventType) return;
    try {
      await addTrigger.mutateAsync({
        automation_id: automationId,
        type: "event",
        event_type: eventType,
        connection_id: connectionId,
        params,
      });
      toast.success("Event trigger added");
      onDone();
    } catch {
      toast.error("Failed to add event trigger");
    }
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-3 rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2">
        <Zap size={14} className="text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">Event trigger</span>
        <button
          type="button"
          className="ml-auto shrink-0 p-0.5 rounded text-muted-foreground hover:text-foreground"
          onClick={onDone}
        >
          <XClose size={13} />
        </button>
      </div>

      {/* Step 1: Connection */}
      <Select
        value={connectionId ?? ""}
        onValueChange={(val) => {
          setConnectionId(val);
          setEventType(undefined);
          setParams({});
        }}
      >
        <SelectTrigger className="w-full">
          <SelectValue placeholder="Select connection..." />
        </SelectTrigger>
        <SelectContent>
          {triggerConnections.length === 0 ? (
            <div className="px-2 py-3 text-center text-xs text-muted-foreground">
              No connections with trigger support
            </div>
          ) : (
            triggerConnections.map((conn) => (
              <SelectItem key={conn.id} value={conn.id}>
                {conn.title}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>

      {/* Step 2: Event type */}
      {connectionId && (
        <Select
          value={eventType ?? ""}
          onValueChange={(val) => {
            setEventType(val);
            setParams({});
          }}
        >
          <SelectTrigger className="w-full">
            {isLoadingTriggers ? (
              <span className="flex items-center gap-2 text-muted-foreground">
                <Loading01 size={13} className="animate-spin" />
                Loading events...
              </span>
            ) : (
              <SelectValue placeholder="Select event type...">
                {eventType ?? "Select event type..."}
              </SelectValue>
            )}
          </SelectTrigger>
          <SelectContent>
            {triggerDefs?.map((t: TriggerDefinition) => (
              <SelectItem key={t.type} value={t.type}>
                <div className="flex flex-col">
                  <span>{t.type}</span>
                  <span className="text-xs text-muted-foreground">
                    {t.description}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}

      {/* Step 3: Params */}
      {selectedTrigger?.paramsSchema &&
        Object.keys(selectedTrigger.paramsSchema).length > 0 && (
          <div className="flex flex-col gap-2">
            {Object.entries(selectedTrigger.paramsSchema).map(
              ([key, schema]) => (
                <div key={key} className="flex flex-col gap-1">
                  <label className="text-xs text-muted-foreground">
                    {key}
                    {schema.description && (
                      <span className="text-muted-foreground/60">
                        {" "}
                        — {schema.description}
                      </span>
                    )}
                  </label>
                  {schema.enum ? (
                    <Select
                      value={params[key] ?? ""}
                      onValueChange={(val) =>
                        setParams((p) => ({ ...p, [key]: val }))
                      }
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder={`Select ${key}...`} />
                      </SelectTrigger>
                      <SelectContent>
                        {schema.enum.map((val) => (
                          <SelectItem key={val} value={val}>
                            {val}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <input
                      type="text"
                      value={params[key] ?? ""}
                      onChange={(e) =>
                        setParams((p) => ({ ...p, [key]: e.target.value }))
                      }
                      placeholder={schema.description ?? key}
                      className="text-sm border border-border rounded-md bg-background px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                  )}
                </div>
              ),
            )}
          </div>
        )}

      {/* Submit */}
      {connectionId && eventType && (
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={addTrigger.isPending}
        >
          {addTrigger.isPending ? (
            <Loading01 size={13} className="animate-spin" />
          ) : (
            "Add trigger"
          )}
        </Button>
      )}
    </div>
  );
}

// ============================================================================
// Settings Tab
// ============================================================================

export function SettingsTab({
  automationId,
  automation,
  fixedAgentId,
  onBack,
  onDelete,
}: {
  automationId: string;
  automation: NonNullable<ReturnType<typeof useAutomationDetail>["data"]>;
  fixedAgentId?: string;
  onBack?: () => void;
  onDelete?: () => void;
}) {
  const { org } = useProjectContext();
  const updateMutation = useAutomationUpdate();
  const allConnections = useConnections();
  const connectionNameMap = new Map(allConnections.map((c) => [c.id, c.title]));

  // Chat hooks for running the automation
  const { createTaskWithMessage } = useChatTask();
  const {
    setVirtualMcpId,
    setModel,
    credentialId: chatCredentialId,
    selectedModel: chatModel,
  } = useChatPrefs();
  const [preferences, setPreferences] = usePreferences();
  const initialTiptapDoc =
    (automation.messages?.[0] as { metadata?: Metadata } | undefined)?.metadata
      ?.tiptapDoc ?? undefined;
  const [tiptapDoc, setTiptapDocRaw] =
    useState<Metadata["tiptapDoc"]>(initialTiptapDoc);
  const [starterOpen, setStarterOpen] = useState(false);
  const [showCustomCron, setShowCustomCron] = useState(false);
  const [cronInput, setCronInput] = useState("");
  const [showEventForm, setShowEventForm] = useState(false);
  const addTrigger = useAutomationTriggerAdd();
  const editorInitializedRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tiptapDirtyRef = useRef(false);

  const handleImprovePrompt = () => {
    const parts = derivePartsFromTiptapDoc(tiptapDoc);
    const instructionsText = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (!instructionsText.trim()) return;

    setPreferences({ ...preferences, toolApprovalLevel: "plan" });

    createTaskWithMessage({
      virtualMcpId: getDecopilotId(org.id),
      message: {
        parts: [
          {
            type: "text",
            text: `/writing-prompts for automation with id ${automationId}. The current message is\n\n<message>\n${instructionsText}\n</message>`,
          },
        ],
      },
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
      agent_id: fixedAgentId ?? automation.agent?.id ?? "",
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

  const saveForm = async (): Promise<boolean> => {
    const hasDirtyFields = Object.keys(form.formState.dirtyFields).length > 0;
    if (!hasDirtyFields && !tiptapDirtyRef.current) return true;
    tiptapDirtyRef.current = false;

    const values = form.getValues();
    try {
      const coercedCredentialId =
        values.credential_id && values.model_id ? values.credential_id : "";
      const coercedModelId =
        values.credential_id && values.model_id ? values.model_id : "";

      const updatePayload = {
        id: automationId,
        name: values.name,
        active: values.active,
        agent: {
          id: fixedAgentId ?? values.agent_id,
        },
        models: {
          credentialId: coercedCredentialId,
          thinking: {
            id: coercedModelId,
          },
        },
        messages: tiptapDocToMessages(tiptapDoc),
        temperature: 0,
      };
      await updateMutation.mutateAsync(updatePayload);
      form.reset({
        ...values,
        credential_id: coercedCredentialId,
        model_id: coercedModelId,
      });
      return true;
    } catch {
      tiptapDirtyRef.current = true;
      toast.error("Failed to save automation");
      return false;
    }
  };

  const debouncedSave = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveForm();
    }, 1000);
  };

  const flushAndSave = async () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    return saveForm();
  };

  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocRaw(doc);
    if (!editorInitializedRef.current) {
      editorInitializedRef.current = true;
      return;
    }
    tiptapDirtyRef.current = true;
    debouncedSave();
  };

  const watchSubscribedRef = useRef(false);
  if (!watchSubscribedRef.current) {
    watchSubscribedRef.current = true;
    form.watch(() => {
      debouncedSave();
    });
  }

  const handleRunClick = async () => {
    const saved = await flushAndSave();
    if (!saved) return;

    if (!tiptapDoc) {
      toast.error("No instructions configured for this automation");
      return;
    }

    const values = form.getValues();

    setVirtualMcpId((fixedAgentId ?? values.agent_id) || null);
    if (selectedModel && watchConnectionId) {
      setModel({ ...selectedModel, keyId: watchConnectionId });
    }

    setPreferences({ ...preferences, toolApprovalLevel: "auto" });

    const parts = derivePartsFromTiptapDoc(tiptapDoc);
    createTaskWithMessage({
      message: { tiptapDoc, parts },
    });
  };

  return (
    <>
      {onBack && (
        <div className="flex items-center pb-4 shrink-0">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to list
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-8">
        {/* Header: Name + Status + Creator */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-4">
            <Input
              {...form.register("name")}
              placeholder="Automation name"
              className="border border-transparent shadow-none px-0 text-lg font-medium h-auto focus-visible:ring-0 focus-visible:border-border bg-transparent flex-1"
            />
            {onDelete && (
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive shrink-0"
                onClick={onDelete}
              >
                <Trash01 size={14} />
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Controller
              control={form.control}
              name="active"
              render={({ field }) => (
                <Switch
                  checked={field.value}
                  onCheckedChange={(checked) => {
                    field.onChange(checked);
                    setTimeout(() => flushAndSave(), 0);
                  }}
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
                setShowEventForm(false);
                setCronInput("");
              }}
              onEventSelect={() => {
                setShowEventForm(true);
                setShowCustomCron(false);
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
                  connectionName={
                    trigger.connection_id
                      ? connectionNameMap.get(trigger.connection_id)
                      : undefined
                  }
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

          {showEventForm && (
            <Suspense
              fallback={
                <div className="flex items-center gap-2 px-3 py-3 rounded-lg border border-border bg-background">
                  <Loading01
                    size={13}
                    className="animate-spin text-muted-foreground"
                  />
                  <span className="text-sm text-muted-foreground">
                    Loading connections...
                  </span>
                </div>
              }
            >
              <EventTriggerForm
                automationId={automationId}
                onDone={() => setShowEventForm(false)}
              />
            </Suspense>
          )}
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
              <TiptapInput
                virtualMcpId={(fixedAgentId ?? watchAgentId) || null}
              />

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
      </div>
    </>
  );
}
