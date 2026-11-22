/**
 * Automation Detail Page
 *
 * Settings and run history for a single automation on one page.
 */

import { EmptyState } from "@/web/components/empty-state.tsx";
import { Page } from "@/web/components/page";
import { SaveActions } from "@/web/components/save-actions";
import {
  useAiProviderModels,
  type AiProviderModel,
} from "@/web/hooks/collections/use-ai-providers.ts";
import { ModelSelector } from "@/web/components/chat/select-model.tsx";
import { User } from "@/web/components/user/user.tsx";
import {
  useAutomationDetail,
  useAutomationUpdate,
  useAutomationDelete,
  useAutomationTriggerAdd,
} from "@/web/hooks/use-automations";
import { useChatTask, useChatPrefs } from "@/web/components/chat/context";
import { useChatPanel } from "@/web/contexts/panel-context";
import { usePreferences } from "@/web/hooks/use-preferences";
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
import { Button } from "@deco/ui/components/button.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Switch } from "@deco/ui/components/switch.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { getDecopilotId, useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowUp,
  Clock,
  Loading01,
  Stars01,
  Trash01,
  XClose,
} from "@untitledui/icons";
import { useRef, useState } from "react";
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

// ============================================================================
// Agent Picker
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

  // Chat hooks for running the automation
  const { createTaskWithMessage } = useChatTask();
  const {
    setVirtualMcpId,
    setModel,
    credentialId: chatCredentialId,
    selectedModel: chatModel,
  } = useChatPrefs();
  const [, setChatOpen] = useChatPanel();
  const [preferences, setPreferences] = usePreferences();
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

  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const handleSave = (): Promise<boolean> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const promise = (async () => {
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
        setSavedDoc(tiptapDoc);
        toast.success("Automation saved");
        return true;
      } catch {
        toast.error("Failed to save automation");
        return false;
      } finally {
        savePromiseRef.current = null;
      }
    })();
    savePromiseRef.current = promise;
    return promise;
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

    setVirtualMcpId((fixedAgentId ?? values.agent_id) || null);
    if (selectedModel && watchConnectionId) {
      setModel({ ...selectedModel, keyId: watchConnectionId });
    }

    setChatOpen(true);
    setPreferences({ ...preferences, toolApprovalLevel: "auto" });

    const parts = derivePartsFromTiptapDoc(tiptapDoc);
    createTaskWithMessage({
      message: { tiptapDoc, parts },
    });
  };

  return (
    <>
      {onBack && (
        <div className="flex items-center justify-between pb-4 shrink-0">
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft size={14} />
            Back to list
          </Button>
          <div className="flex items-center gap-2">
            <SaveActions
              onSave={async () => {
                await handleSave();
              }}
              onUndo={handleUndo}
              isDirty={isDirty}
              isSaving={updateMutation.isPending}
            />
          </div>
        </div>
      )}

      <div className="flex flex-col gap-8">
        {/* Header: Name + Status + Creator */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-4">
            <Input
              {...form.register("name")}
              onBlur={() => {
                if (form.formState.isDirty) void handleSave();
              }}
              placeholder="Automation name"
              className="border border-transparent shadow-none px-0 text-lg font-medium h-auto focus-visible:ring-0 focus-visible:border-border bg-transparent flex-1"
            />
            <div className="flex items-center gap-2 shrink-0">
              {!onBack && (
                <SaveActions
                  onSave={async () => {
                    await handleSave();
                  }}
                  onUndo={handleUndo}
                  isDirty={isDirty}
                  isSaving={updateMutation.isPending}
                />
              )}
              {onDelete && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={onDelete}
                >
                  <Trash01 size={14} />
                </Button>
              )}
            </div>
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
                    setTimeout(() => handleSave(), 0);
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
            <div
              className="rounded-xl border border-border min-h-[120px] flex flex-col"
              onBlur={(e) => {
                // Skip if focus moved to another element inside this container
                if (e.currentTarget.contains(e.relatedTarget)) return;
                const docChanged =
                  JSON.stringify(tiptapDoc ?? null) !==
                  JSON.stringify(savedDoc ?? null);
                if (form.formState.isDirty || docChanged) {
                  void handleSave();
                }
              }}
            >
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

// ============================================================================
// Main Component
// ============================================================================

export default function AutomationDetailPage() {
  const { automationId } = useParams({
    from: "/shell/$org/settings/automations/$automationId",
  });
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
        to: "/$org/settings/automations",
        params: { org: org.slug },
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

  return (
    <Page>
      <Page.Content>
        <Page.Body className="md:pt-8">
          <SettingsTab
            key={automationId}
            automationId={automationId}
            automation={automation}
            onDelete={() => setConfirmDelete(true)}
          />
        </Page.Body>
      </Page.Content>

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
    </Page>
  );
}
