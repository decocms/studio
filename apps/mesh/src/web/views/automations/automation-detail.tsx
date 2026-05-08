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
import {
  SimpleModeTierDropdown,
  type SimpleModeTier,
} from "@/web/components/chat/simple-mode-tier-dropdown.tsx";
import { useSimpleMode } from "@/web/hooks/use-organization-settings";
import { User } from "@/web/components/user/user.tsx";
import {
  useAutomation,
  useAutomationActions,
  useTriggerList,
  type TriggerDefinition,
} from "@/web/hooks/use-automations";
import {
  useChatTask,
  useChatPrefs,
  useChatBridge,
} from "@/web/components/chat/context";
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
  StudioPackAgentId,
  useConnections,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { usePanelActions } from "@/web/layouts/shell-layout";
import { useEnsureStudioPack } from "@/web/components/home/use-ensure-studio-pack";
import { buildImprovePromptDoc } from "@/web/components/chat/tiptap/build-improve-prompt-doc";
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
import { Suspense, useEffect, useReducer, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useDebouncedAutosave } from "@/web/hooks/use-debounced-autosave.ts";
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
  credential_id: string;
  model_id: string;
  // Empty string when the automation isn't pinned to a Simple Mode tier.
  // When set, the server resolves the model from the live tier slot at run
  // time, so credential_id / model_id act as a display snapshot only.
  tier: SimpleModeTier | "";
}

type EditSession = {
  start: number;
  fields: Set<string>;
  saveCount: number;
};

type EditSessionAction =
  | { type: "accumulate"; now: number; fields: string[] }
  | { type: "reset" };

function editSessionReducer(
  state: EditSession | null,
  action: EditSessionAction,
): EditSession | null {
  switch (action.type) {
    case "accumulate": {
      const base: EditSession = state ?? {
        start: action.now,
        fields: new Set(),
        saveCount: 0,
      };
      const fields = new Set(base.fields);
      for (const f of action.fields) fields.add(f);
      return { ...base, fields, saveCount: base.saveCount + 1 };
    }
    case "reset":
      return null;
  }
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
import { track } from "@/web/lib/posthog-client";

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
  const { triggerAdd: addTrigger } = useAutomationActions();
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
      track("automation_trigger_added", {
        automation_id: automationId,
        trigger_type: "event",
        connection_id: connectionId,
        event_type: eventType,
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
  onBack,
  onDelete,
}: {
  automationId: string;
  automation: NonNullable<ReturnType<typeof useAutomation>["data"]>;
  onBack?: () => void;
  onDelete?: () => void;
}) {
  const agentId = automation.virtual_mcp_id;
  const { org } = useProjectContext();
  const { update: updateMutation, triggerAdd: addTrigger } =
    useAutomationActions();
  const allConnections = useConnections();
  const connectionNameMap = new Map(allConnections.map((c) => [c.id, c.title]));

  // Chat hooks for running the automation
  const { createTaskWithMessage } = useChatTask();
  const {
    setModel,
    setSimpleModeTier,
    credentialId: chatCredentialId,
    selectedModel: chatModel,
  } = useChatPrefs();
  const simpleMode = useSimpleMode();
  const { setChatOpen } = usePanelActions();
  const { sendMessage } = useChatBridge();
  const ensureStudioPack = useEnsureStudioPack();
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
  const [isImproving, setIsImproving] = useState(false);
  // The editor's first setTiptapDoc call is the mount-time normalization,
  // not a user edit — we skip it so it doesn't mark dirty / autosave.
  const [editorInitialized, setEditorInitialized] = useState(false);
  // Tiptap is not in the RHF form (mount normalization would mark dirty
  // before the user has typed anything). We track tiptap-dirty here and
  // mix it into saveForm's "should we send?" decision alongside RHF's
  // dirtyFields.
  const [tiptapDirty, setTiptapDirty] = useState(false);

  const handleImprovePrompt = async () => {
    if (isImproving) return;
    const parts = derivePartsFromTiptapDoc(tiptapDoc);
    const instructionsText = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (!instructionsText.trim()) return;

    setIsImproving(true);
    try {
      forceSessionFlush();
      track("automation_improve_clicked", {
        automation_id: automationId,
        agent_id: agentId,
        instructions_length: instructionsText.length,
      });

      await ensureStudioPack(["studio-automation-manager"]);

      setChatOpen(true);

      await sendMessage({
        tiptapDoc: buildImprovePromptDoc({
          managerAgentId: StudioPackAgentId.AUTOMATION_MANAGER(org.id),
          managerName: "Automation Manager",
          kind: "automation",
          id: automationId,
          instructions: instructionsText,
        }),
      });
    } finally {
      setIsImproving(false);
    }
  };

  const defaultCredentialId =
    automation.models?.credentialId || chatCredentialId || "";
  const defaultModelId =
    automation.models?.thinking?.id || chatModel?.modelId || "";
  const defaultTier: SimpleModeTier | "" = automation.models?.tier ?? "";

  const form = useForm<SettingsFormData>({
    defaultValues: {
      name: automation.name,
      active: automation.active,
      credential_id: defaultCredentialId,
      model_id: defaultModelId,
      tier: defaultTier,
    },
  });

  const watchActive = form.watch("active");
  const watchConnectionId = form.watch("credential_id");
  const watchModelId = form.watch("model_id");

  const { models, isLoading: isModelsLoading } = useAiProviderModels(
    watchConnectionId || undefined,
  );
  const selectedModel: AiProviderModel | null =
    models.find((m) => m.modelId === watchModelId) ?? null;

  const watchTier = form.watch("tier");
  // The slot the saved credential/model actually correspond to, if any.
  // Used both for the dropdown label and to decide whether saving is safe
  // to auto-pin a legacy automation — we only persist `tier` when we know
  // with certainty which slot the existing model matches.
  const slotMatchedTier = (["fast", "smart", "thinking"] as const).find(
    (t) =>
      simpleMode.chat[t]?.modelId === watchModelId &&
      simpleMode.chat[t]?.keyId === watchConnectionId,
  );
  // Persisted tier (from automation.models.tier) wins so the dropdown stays
  // truthful even when slots are reconfigured server-side. Falls back to
  // slot-match, then to "smart" as a final default for the dropdown label.
  const activeSimpleModeTier: SimpleModeTier =
    watchTier || slotMatchedTier || "smart";

  const handleSimpleModeTierSelect = (tier: SimpleModeTier) => {
    const slot = simpleMode.chat[tier];
    if (!slot) return;
    form.setValue("credential_id", slot.keyId, { shouldDirty: true });
    form.setValue("model_id", slot.modelId, { shouldDirty: true });
    form.setValue("tier", tier, { shouldDirty: true });
  };

  // Session-based tracking for automation_updated. Auto-saves persist every
  // ~1s but we only emit one PostHog event per edit-session (aggregated
  // fields + save_count + edit_duration_ms). A session ends after 30s of
  // quiet, or on explicit flush (tab-leave, improve, test).
  const [editSession, dispatchEditSession] = useReducer(
    editSessionReducer,
    null,
  );

  const flushEditSession = () => {
    if (editSession === null) return;
    track("automation_updated", {
      automation_id: automationId,
      agent_id: agentId,
      fields: Array.from(editSession.fields),
      save_count: editSession.saveCount,
      edit_duration_ms: Date.now() - editSession.start,
    });
    dispatchEditSession({ type: "reset" });
  };

  const saveForm = async (): Promise<boolean> => {
    // form.formState is a Proxy over React state. When saveForm runs
    // synchronously after setValue (e.g. via flushAndSave), React hasn't
    // processed the batched update yet and form.formState.dirtyFields
    // returns the previous render's snapshot — empty on the first edit — so
    // the save would bail. Read control._formState.dirtyFields for the live
    // value. Same gotcha as virtual-mcp.
    const liveDirtyFields = (
      form.control as unknown as {
        _formState: { dirtyFields: Record<string, unknown> };
      }
    )._formState.dirtyFields;
    const dirtyKeys = Object.keys(liveDirtyFields);
    if (dirtyKeys.length === 0 && !tiptapDirty) return true;

    const values = form.getValues();
    const coercedCredentialId =
      values.credential_id && values.model_id ? values.credential_id : "";
    const coercedModelId =
      values.credential_id && values.model_id ? values.model_id : "";

    // Reflect coercion in the form so the UI matches what we're persisting.
    // shouldDirty is left as the default (false) — these aren't user edits;
    // the rebase below will adopt them as the new baseline.
    if (coercedCredentialId !== values.credential_id) {
      form.setValue("credential_id", coercedCredentialId);
    }
    if (coercedModelId !== values.model_id) {
      form.setValue("model_id", coercedModelId);
    }

    const formData = form.getValues();
    const previousDefaults = (
      form.control as unknown as { _defaultValues: SettingsFormData }
    )._defaultValues;

    // Rebase the dirty baseline pre-mutate so an edit during the in-flight
    // save that returns a value to its pre-save default still registers as
    // dirty. keepValues preserves user view; only _defaultValues advances.
    form.reset(formData, { keepValues: true });
    const tiptapWasDirty = tiptapDirty;
    setTiptapDirty(false);

    // Persist `tier` only when we have a confident signal: an explicit form
    // value (set via the tier dropdown) or a saved model that actually
    // matches a configured slot. Legacy automations whose model doesn't
    // match any slot are NOT silently re-pinned to the default tier on
    // incidental edits — that would change which model the run path uses
    // with no UI signal.
    const tierToPersist: SimpleModeTier | undefined = simpleMode.enabled
      ? formData.tier || slotMatchedTier
      : formData.tier || undefined;

    const updatePayload = {
      id: automationId,
      name: formData.name,
      active: formData.active,
      models: {
        credentialId: coercedCredentialId,
        thinking: { id: coercedModelId },
        ...(tierToPersist ? { tier: tierToPersist } : {}),
      },
      messages: tiptapDocToMessages(tiptapDoc),
      temperature: 0,
    };

    try {
      await updateMutation.mutateAsync(updatePayload);
    } catch {
      // Roll back the rebase so user edits remain dirty for the next attempt.
      form.reset(previousDefaults, { keepValues: true });
      if (tiptapWasDirty) setTiptapDirty(true);
      return false;
    }

    const fields = [...dirtyKeys];
    if (tiptapWasDirty) fields.push("messages");
    dispatchEditSession({ type: "accumulate", now: Date.now(), fields });
    scheduleSessionFlush();
    return true;
  };

  const { schedule: scheduleSave, flush: flushAndSave } = useDebouncedAutosave({
    save: saveForm,
  });

  const { schedule: scheduleSessionFlush, flush: forceSessionFlush } =
    useDebouncedAutosave({
      delayMs: 30_000,
      save: async () => flushEditSession(),
    });

  // form.watch(callback) fires on value changes via setValue, but not on
  // form.reset({ keepValues: true }) (which only emits state, no `values`
  // key) — so saveForm's pre-mutate rebase does NOT loop. Edit handlers can
  // just call form.setValue with shouldDirty:true and trust this
  // subscription to schedule the save. flushAndSave remains for explicit
  // "save NOW" semantics.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    const sub = form.watch(() => scheduleSave());
    return () => sub.unsubscribe();
    // scheduleSave is stable for our purpose: its closure mediates through
    // stable refs inside useDebouncedAutosave.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setTiptapDoc = (doc: Metadata["tiptapDoc"]) => {
    setTiptapDocRaw(doc);
    if (!editorInitialized) {
      setEditorInitialized(true);
      return;
    }
    setTiptapDirty(true);
    scheduleSave();
  };

  const handleRunClick = async () => {
    track("automation_test_clicked", {
      automation_id: automationId,
      agent_id: agentId,
    });
    const saved = await flushAndSave();
    forceSessionFlush();
    if (!saved) return;

    if (!tiptapDoc) {
      toast.error("No instructions configured for this automation");
      return;
    }

    if (simpleMode.enabled) {
      setSimpleModeTier(activeSimpleModeTier);
    } else if (selectedModel && watchConnectionId) {
      setModel({ ...selectedModel, keyId: watchConnectionId });
    }

    setChatOpen(true);
    setPreferences({ ...preferences, toolApprovalLevel: "auto" });

    const parts = derivePartsFromTiptapDoc(tiptapDoc);
    createTaskWithMessage({
      message: { tiptapDoc, parts },
      virtualMcpId: agentId || undefined,
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
            <Controller
              control={form.control}
              name="name"
              render={({ field }) => (
                <Input
                  {...field}
                  placeholder="Automation name"
                  className="border border-transparent shadow-none px-0 text-lg font-medium h-auto focus-visible:ring-0 focus-visible:border-border bg-transparent flex-1"
                  style={{ boxShadow: "none" }}
                />
              )}
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
                    flushAndSave();
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
                    track("automation_trigger_added", {
                      automation_id: automationId,
                      trigger_type: "cron",
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
              disabled={isImproving || !tiptapDoc}
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
                virtualMcpId={agentId || null}
                className="max-h-[45vh]"
              />

              <div className="flex items-center justify-end gap-1.5 p-2.5">
                {simpleMode.enabled ? (
                  <SimpleModeTierDropdown
                    tier={activeSimpleModeTier}
                    onSelect={handleSimpleModeTierSelect}
                  />
                ) : (
                  <ModelSelector
                    model={selectedModel}
                    isLoading={isModelsLoading}
                    credentialId={watchConnectionId || null}
                    onCredentialChange={(id) => {
                      form.setValue("credential_id", id ?? "", {
                        shouldDirty: true,
                      });
                      form.setValue("model_id", "", { shouldDirty: true });
                      form.setValue("tier", "", { shouldDirty: true });
                    }}
                    onModelChange={(model) => {
                      form.setValue("model_id", model.modelId, {
                        shouldDirty: true,
                      });
                      form.setValue("tier", "", { shouldDirty: true });
                    }}
                    placeholder="Model"
                  />
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="default"
                      className="h-8 gap-1.5 rounded-md px-3 text-sm font-medium"
                      onClick={handleRunClick}
                      disabled={!agentId}
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
