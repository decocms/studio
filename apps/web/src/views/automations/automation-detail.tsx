/**
 * Automation Detail Page
 *
 * Settings and run history for a single automation on one page.
 */

import { type SimpleModeTier } from "@/components/chat/simple-mode-tier-dropdown";
import {
  AutomationModelControl,
  AutomationToolsControl,
  type AutomationModelOverride,
} from "@/components/automations/automation-config";
import { User } from "@/components/user/user.tsx";
import { useAutomation, useAutomationActions } from "@/hooks/use-automations";
import { useChatTask, useChatStream } from "@/components/chat/context";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Switch } from "@decocms/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { StudioPackAgentId, useConnections, useProjectContext } from "@/sdk";
import { usePanelActions } from "@/layouts/shell-layout";
import { buildImprovePromptDoc } from "@/components/chat/tiptap/build-improve-prompt-doc";
import {
  ArrowLeft,
  ArrowUp,
  ChevronDown,
  Clock,
  Loading01,
  Stars01,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { Suspense, useEffect, useReducer, useState } from "react";
import { useForm, Controller } from "react-hook-form";
import { useDebouncedAutosave } from "@/hooks/use-debounced-autosave.ts";
import { toast } from "sonner";
import type { Metadata } from "@/components/chat/types.ts";
import {
  TiptapProvider,
  TiptapInput,
} from "@/components/chat/tiptap/input.tsx";
import {
  derivePartsFromTiptapDoc,
  tiptapDocToMessages,
} from "@/components/chat/derive-parts.ts";

// ============================================================================
// Types
// ============================================================================

interface SettingsFormData {
  name: string;
  active: boolean;
  tier: SimpleModeTier;
  // Specific-model override (null when using the tier preset).
  modelOverride: AutomationModelOverride | null;
  // Tool allowlist (null = all of the agent's tools).
  tools: string[] | null;
  // Parent agent-loop step cap (null = platform default).
  maxAgentSteps: number | null;
}

// Platform default for the parent agent loop (PARENT_STEP_LIMIT) — shown as
// the placeholder when no per-automation override is set.
const DEFAULT_MAX_AGENT_STEPS = 30;

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

import { isValidCron } from "@/lib/cron-utils.ts";
import { AddStarterPopover } from "@/components/automations/add-starter-popover.tsx";
import { TriggerCard } from "@/components/automations/trigger-card.tsx";
import { WebhookSecretDialog } from "@/components/automations/webhook-secret-dialog.tsx";
import { EventTriggerForm } from "@/components/automations/event-trigger-form.tsx";
import { track } from "@/lib/posthog-client";
import { useT } from "@/i18n/use-t.ts";

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
  const t = useT();
  const agentId = automation.virtual_mcp_id;
  const { org } = useProjectContext();
  const {
    update: updateMutation,
    triggerAdd: addTrigger,
    run: runMutation,
  } = useAutomationActions();
  const allConnections = useConnections();
  const connectionNameMap = new Map(allConnections.map((c) => [c.id, c.title]));

  // Chat hooks for running the automation
  const { openTask } = useChatTask();
  const { openSidePanel } = usePanelActions();
  const { sendMessage } = useChatStream();
  const initialTiptapDoc =
    (automation.messages?.[0] as { metadata?: Metadata } | undefined)?.metadata
      ?.tiptapDoc ?? undefined;
  const [tiptapDoc, setTiptapDocRaw] =
    useState<Metadata["tiptapDoc"]>(initialTiptapDoc);
  const [starterOpen, setStarterOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [showCustomCron, setShowCustomCron] = useState(false);
  const [cronInput, setCronInput] = useState("");
  const [showEventForm, setShowEventForm] = useState(false);
  const [webhookSecret, setWebhookSecret] = useState<{
    url: string;
    token: string;
  } | null>(null);
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

      openSidePanel("chat");

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

  const defaultTier: SimpleModeTier = automation.models?.tier ?? "smart";
  const defaultModelOverride: AutomationModelOverride | null =
    automation.models?.modelId && automation.models?.credentialId
      ? {
          modelId: automation.models.modelId,
          credentialId: automation.models.credentialId,
          title: automation.models.modelTitle ?? automation.models.modelId,
        }
      : null;

  const form = useForm<SettingsFormData>({
    defaultValues: {
      name: automation.name,
      active: automation.active,
      tier: defaultTier,
      modelOverride: defaultModelOverride,
      tools: automation.tools ?? null,
      maxAgentSteps: automation.maxAgentSteps ?? null,
    },
  });

  const watchActive = form.watch("active");

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

    const models = {
      tier: formData.tier,
      ...(formData.modelOverride
        ? {
            modelId: formData.modelOverride.modelId,
            credentialId: formData.modelOverride.credentialId,
            modelTitle: formData.modelOverride.title,
          }
        : {}),
    };
    const updatePayload = {
      id: automationId,
      name: formData.name,
      active: formData.active,
      models,
      tools: formData.tools,
      maxAgentSteps: formData.maxAgentSteps,
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
      toast.error(t("automations.automationDetail.noInstructionsConfigured"));
      return;
    }

    // Fire through the real automation path so the test honors the pinned
    // model + tool allowlist exactly as a scheduled/triggered fire would,
    // then open the resulting run thread with Chat in the side panel.
    try {
      const result = await runMutation.mutateAsync(automationId);
      if (result.threadId) {
        openSidePanel("chat");
        openTask(result.threadId);
      }
    } catch {
      // runMutation surfaces its own error toast.
    }
  };

  return (
    <>
      {onBack && (
        <div className="flex items-center pb-4 shrink-0">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={14} />
            {t("automations.automationDetail.backToList")}
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
                  placeholder={t(
                    "automations.automationDetail.automationNamePlaceholder",
                  )}
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
              {watchActive
                ? t("automations.automationDetail.active")
                : t("automations.automationDetail.inactive")}
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
              {t("automations.automationDetail.starter")}
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
              onWebhookCreated={(secret) => {
                track("automation_trigger_added", {
                  automation_id: automationId,
                  trigger_type: "webhook",
                });
                setWebhookSecret(secret);
              }}
            />
          </div>

          {automation.triggers.length === 0 && !showCustomCron ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
              <p className="text-sm text-muted-foreground">
                {t("automations.automationDetail.whenShouldRun")}{" "}
                <button
                  type="button"
                  className="text-foreground underline underline-offset-2 cursor-pointer hover:text-foreground/80 transition-colors"
                  onClick={() => setStarterOpen(true)}
                >
                  {t("automations.automationDetail.addStarter")}
                </button>{" "}
                {t("automations.automationDetail.toGetGoing")}
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
                    toast.success(
                      t("automations.automationDetail.starterAdded"),
                    );
                    setShowCustomCron(false);
                    setCronInput("");
                  } catch {
                    toast.error(
                      t("automations.automationDetail.failedToAddStarter"),
                    );
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
                  {t("automations.automationDetail.invalid")}
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
                    {t("automations.automationDetail.loadingConnections")}
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

          <WebhookSecretDialog
            open={webhookSecret !== null}
            onOpenChange={(open) => {
              if (!open) setWebhookSecret(null);
            }}
            url={webhookSecret?.url ?? null}
            token={webhookSecret?.token ?? null}
          />
        </div>

        {/* Section: Instructions */}
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-muted-foreground/60">
              {t("automations.automationDetail.instructions")}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-xs"
              disabled={isImproving || !tiptapDoc}
              onClick={handleImprovePrompt}
            >
              <Stars01 size={13} />
              {t("automations.automationDetail.improve")}
            </Button>
          </div>
          <TiptapProvider
            tiptapDoc={tiptapDoc}
            setTiptapDoc={setTiptapDoc}
            placeholder={t(
              "automations.automationDetail.instructionsPlaceholder",
            )}
          >
            <div className="rounded-xl border border-border min-h-[120px] flex flex-col">
              <TiptapInput
                virtualMcpId={agentId || null}
                className="max-h-[45vh]"
              />

              <div className="@container/chat-bottom flex items-center justify-end gap-1.5 p-2.5">
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
                      {t("automations.automationDetail.test")}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("automations.automationDetail.testAutomation")}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </TiptapProvider>
        </div>

        {/* Section: Advanced (Model, Tools, Max steps) */}
        <Collapsible
          open={advancedOpen}
          onOpenChange={setAdvancedOpen}
          className="flex flex-col gap-2.5"
        >
          <CollapsibleTrigger className="group flex w-fit cursor-pointer items-center gap-1.5">
            <span className="text-xs font-semibold text-muted-foreground/60">
              {t("automations.automationDetail.advanced")}
            </span>
            <ChevronDown
              size={14}
              className="text-muted-foreground/60 transition-transform group-data-[state=open]:rotate-180"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-5 pt-0.5">
            <AutomationModelControl
              tier={form.watch("tier")}
              onTierChange={(tier) =>
                form.setValue("tier", tier, { shouldDirty: true })
              }
              override={form.watch("modelOverride")}
              onOverrideChange={(o) =>
                form.setValue("modelOverride", o, { shouldDirty: true })
              }
            />
            <AutomationToolsControl
              agentId={agentId || null}
              value={form.watch("tools")}
              onChange={(v) => form.setValue("tools", v, { shouldDirty: true })}
            />
            <div className="flex flex-col gap-2">
              <span className="text-xs font-semibold text-muted-foreground/60">
                {t("automations.automationDetail.maxSteps")}
              </span>
              <Input
                type="number"
                min={1}
                max={100}
                className="w-40"
                placeholder={t(
                  "automations.automationDetail.maxStepsPlaceholder",
                  { default: DEFAULT_MAX_AGENT_STEPS },
                )}
                value={form.watch("maxAgentSteps") ?? ""}
                onChange={(e) => {
                  const raw = e.target.value.trim();
                  const next = raw === "" ? null : Number(raw);
                  form.setValue(
                    "maxAgentSteps",
                    next === null || Number.isNaN(next) ? null : next,
                    { shouldDirty: true },
                  );
                }}
              />
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </>
  );
}
