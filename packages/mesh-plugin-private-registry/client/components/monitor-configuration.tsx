import { useRef, useState } from "react";
import {
  useCollectionList,
  useConnections,
  useMCPClientOptional,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { LLMModelSelector } from "@deco/ui/components/llm-model-selector.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { MessageQuestionCircle } from "@untitledui/icons";
import { useRegistryConfig } from "../hooks/use-registry";
import {
  useMonitorScheduleCancel,
  useMonitorScheduleSet,
  useRegistryMonitorConfig,
} from "../hooks/use-monitor";
import type {
  MonitorFailureAction,
  MonitorMode,
  RegistryMonitorConfig,
} from "../lib/types";
import { MONITOR_AGENT_DEFAULT_SYSTEM_PROMPT, PLUGIN_ID } from "../../shared";
import { CronScheduleSelector } from "./cron-schedule-selector";

function hasChanges(
  a: RegistryMonitorConfig,
  b: RegistryMonitorConfig,
): boolean {
  return (
    a.monitorMode !== b.monitorMode ||
    a.onFailure !== b.onFailure ||
    a.llmConnectionId !== b.llmConnectionId ||
    a.llmModelId !== b.llmModelId ||
    a.perMcpTimeoutMs !== b.perMcpTimeoutMs ||
    a.perToolTimeoutMs !== b.perToolTimeoutMs ||
    a.maxAgentSteps !== b.maxAgentSteps ||
    a.testPublicOnly !== b.testPublicOnly ||
    a.testPrivateOnly !== b.testPrivateOnly ||
    a.includePendingRequests !== b.includePendingRequests ||
    (a.agentContext ?? "") !== (b.agentContext ?? "") ||
    a.schedule !== b.schedule ||
    a.cronExpression !== b.cronExpression
  );
}

export function MonitorConfiguration() {
  const { registryLLMConnectionId, registryLLMModelId } =
    useRegistryConfig(PLUGIN_ID);
  const { settings, saveMutation } = useRegistryMonitorConfig();
  const scheduleSetMutation = useMonitorScheduleSet();
  const scheduleCancelMutation = useMonitorScheduleCancel();
  const prevSettingsRef = useRef(settings);
  const [draft, setDraft] = useState<RegistryMonitorConfig>(settings);
  const [justSaved, setJustSaved] = useState(false);
  const [showDefaultPrompt, setShowDefaultPrompt] = useState(false);
  const { org } = useProjectContext();
  const allConnections = useConnections();
  const llmConnections = (allConnections ?? []).filter((connection) =>
    (connection.tools ?? []).some((tool) => tool.name === "LLM_DO_GENERATE"),
  );
  const effectiveLLMConnectionId =
    draft.llmConnectionId ||
    registryLLMConnectionId ||
    llmConnections[0]?.id ||
    "";
  const llmClient = useMCPClientOptional({
    connectionId: effectiveLLMConnectionId || undefined,
    orgId: org.id,
  });
  const llmModels = useCollectionList<{
    id: string;
    title: string;
    created_at: string;
    updated_at: string;
    description?: string | null;
    logo?: string | null;
    capabilities?: string[];
  }>(effectiveLLMConnectionId || "no-llm-connection", "LLM", llmClient);

  // Sync draft when external settings change (replaces useEffect)
  if (prevSettingsRef.current !== settings) {
    prevSettingsRef.current = settings;
    setDraft(settings);
  }

  const isDirty = hasChanges(draft, settings);

  const setPartial = (patch: Partial<RegistryMonitorConfig>) => {
    setJustSaved(false);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const save = async () => {
    const normalizedCron = draft.cronExpression?.trim() ?? "";
    let scheduleEventId = settings.scheduleEventId ?? "";

    if (draft.schedule === "cron" && normalizedCron.length > 0) {
      const cronChanged = normalizedCron !== (settings.cronExpression ?? "");
      if (cronChanged && scheduleEventId) {
        await scheduleCancelMutation.mutateAsync(scheduleEventId);
      }
      if (cronChanged || !scheduleEventId) {
        const scheduleResult = await scheduleSetMutation.mutateAsync({
          cronExpression: normalizedCron,
          config: draft,
        });
        scheduleEventId = scheduleResult.scheduleEventId;
      }
    } else if (scheduleEventId) {
      await scheduleCancelMutation.mutateAsync(scheduleEventId);
      scheduleEventId = "";
    }

    const normalizedModelId = (draft.llmModelId ?? "").trim();
    const normalizedConnectionId = normalizedModelId
      ? (draft.llmConnectionId || effectiveLLMConnectionId || "").trim()
      : (draft.llmConnectionId ?? "").trim();

    const nextDraft: RegistryMonitorConfig = {
      ...draft,
      cronExpression: normalizedCron,
      scheduleEventId,
      agentContext: (draft.agentContext ?? "").trim(),
      llmConnectionId: normalizedConnectionId,
      llmModelId: normalizedModelId,
    };
    await saveMutation.mutateAsync(nextDraft);
    setDraft(nextDraft);
    setJustSaved(true);
    setTimeout(() => setJustSaved(false), 3000);
  };

  return (
    <Card className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">QA Configuration</h3>
          <p className="text-xs text-muted-foreground">
            Configure how the MCP QA agent validates registry entries.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <Badge className="bg-amber-500/10 text-amber-600 border-amber-500/20 text-[10px]">
              Unsaved changes
            </Badge>
          )}
          {justSaved && (
            <Badge className="bg-emerald-500/10 text-emerald-600 border-emerald-500/20 text-[10px]">
              ✓ Saved
            </Badge>
          )}
          <Button
            size="sm"
            onClick={save}
            disabled={
              saveMutation.isPending ||
              scheduleSetMutation.isPending ||
              scheduleCancelMutation.isPending ||
              !isDirty
            }
          >
            {saveMutation.isPending ||
            scheduleSetMutation.isPending ||
            scheduleCancelMutation.isPending
              ? "Saving..."
              : "Save settings"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <FieldLabel
            label="QA mode"
            hint="Defines HOW each MCP is validated: connectivity only, direct tool calls, or multi-step agent execution."
          />
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={draft.monitorMode}
            onChange={(e) =>
              setPartial({ monitorMode: e.target.value as MonitorMode })
            }
          >
            <option value="health_check">Health check</option>
            <option value="tool_call">Tool call</option>
            <option value="full_agent">Agentic (LLM model)</option>
          </select>
        </div>

        <div className="space-y-1">
          <FieldLabel
            label="On failure"
            hint="Automatic action to apply when an MCP fails tests in a run."
          />
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={draft.onFailure}
            onChange={(e) =>
              setPartial({ onFailure: e.target.value as MonitorFailureAction })
            }
          >
            <option value="none">Do nothing</option>
            <option value="unlisted">
              Unlist from store (keep in registry)
            </option>
            <option value="remove_public">Remove from public store</option>
            <option value="remove_private">Remove from private registry</option>
            <option value="remove_all">
              Remove from all (public + private)
            </option>
          </select>
        </div>

        <div className="space-y-1">
          <FieldLabel
            label="Test scope"
            hint="Choose whether tests should run for public items, private items, or both."
          />
          <div className="flex items-center gap-4 rounded-md border border-input px-3 py-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.testPublicOnly}
                onChange={(event) =>
                  setPartial({
                    testPublicOnly: event.target.checked,
                    testPrivateOnly: event.target.checked
                      ? false
                      : draft.testPrivateOnly,
                  })
                }
              />
              Public only
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.testPrivateOnly}
                onChange={(event) =>
                  setPartial({
                    testPrivateOnly: event.target.checked,
                    testPublicOnly: event.target.checked
                      ? false
                      : draft.testPublicOnly,
                  })
                }
              />
              Private only
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <FieldLabel
            label="Publish requests"
            hint="Include pending publish requests in QA runs to validate them before publishing to the store."
          />
          <div className="flex items-center gap-4 rounded-md border border-input px-3 py-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={draft.includePendingRequests}
                onChange={(event) =>
                  setPartial({ includePendingRequests: event.target.checked })
                }
              />
              Include pending requests in tests
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <FieldLabel
            label="What is tested?"
            hint="Clarifies the difference between QA mode and test execution output."
          />
          <div className="rounded-md border border-input bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <p>
              <strong>QA mode</strong> defines the execution strategy.
            </p>
            <p>
              <strong>QA run history</strong> stores past runs.
            </p>
            <p>
              <strong>QA results log</strong> shows per-MCP outcomes inside one
              run.
            </p>
          </div>
        </div>

        <div className="space-y-1 md:col-span-2">
          <FieldLabel
            label="Model (LLM binding)"
            hint="Used only in Agentic mode to decide and chain tool calls."
          />
          <LLMModelSelector
            connectionId={effectiveLLMConnectionId}
            modelId={draft.llmModelId ?? ""}
            connections={llmConnections.map((connection) => ({
              id: connection.id,
              title: connection.title,
              icon: connection.icon ?? null,
            }))}
            models={llmModels.map((model) => ({
              id: model.id,
              title: model.title || model.id,
              logo: model.logo ?? null,
              capabilities: model.capabilities ?? [],
            }))}
            onConnectionChange={(value) =>
              setPartial({
                llmConnectionId: value,
                llmModelId: "",
              })
            }
            onModelChange={(value) => setPartial({ llmModelId: value })}
          />
        </div>

        <div className="space-y-1 md:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel
              label="Additional test context (prompt)"
              hint="Extra runtime context passed to the agent, such as valid emails, tenant IDs, or known test entities."
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => setShowDefaultPrompt((prev) => !prev)}
            >
              {showDefaultPrompt ? "Hide" : "View"} default system prompt
            </Button>
          </div>
          <Textarea
            value={draft.agentContext ?? ""}
            onChange={(e) => setPartial({ agentContext: e.target.value })}
            placeholder='Example: Use "my-user@company.com" as a valid email for Google Drive share/create_permission tests.'
            rows={3}
          />
          <p className="text-[11px] text-muted-foreground">
            Use this field for real data required by some tools (valid email,
            fixed IDs, test environment details, etc).
          </p>
          {showDefaultPrompt && (
            <pre className="text-[11px] bg-muted/50 border border-border rounded px-3 py-2 whitespace-pre-wrap max-h-64 overflow-auto">
              {MONITOR_AGENT_DEFAULT_SYSTEM_PROMPT}
            </pre>
          )}
        </div>

        <div className="space-y-1 md:col-span-2">
          <FieldLabel
            label="Schedule"
            hint="Set automatic test runs. Manual mode runs only when you click Start QA run."
          />
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={draft.schedule ?? "manual"}
            onChange={(e) =>
              setPartial({
                schedule: e.target.value as RegistryMonitorConfig["schedule"],
              })
            }
          >
            <option value="manual">Manual only</option>
            <option value="cron">Cron schedule</option>
          </select>
          {(draft.schedule ?? "manual") === "cron" && (
            <CronScheduleSelector
              value={draft.cronExpression ?? ""}
              onChange={(cronExpression) => setPartial({ cronExpression })}
            />
          )}
        </div>

        <div className="space-y-1">
          <FieldLabel
            label="Per MCP timeout (ms)"
            hint="Max total time allowed to validate one MCP."
          />
          <Input
            type="number"
            value={draft.perMcpTimeoutMs}
            onChange={(e) =>
              setPartial({ perMcpTimeoutMs: Number(e.target.value) })
            }
          />
        </div>

        <div className="space-y-1">
          <FieldLabel
            label="Per tool timeout (ms)"
            hint="Max time allowed for each individual tool call."
          />
          <Input
            type="number"
            value={draft.perToolTimeoutMs}
            onChange={(e) =>
              setPartial({ perToolTimeoutMs: Number(e.target.value) })
            }
          />
        </div>

        <div className="space-y-1">
          <FieldLabel
            label="Max agent steps"
            hint="Maximum number of reasoning/tool steps in Agentic mode."
          />
          <Input
            type="number"
            value={draft.maxAgentSteps}
            onChange={(e) =>
              setPartial({ maxAgentSteps: Number(e.target.value) })
            }
            min={1}
            max={30}
          />
        </div>
      </div>

      <div className="text-xs text-muted-foreground">
        LLM fallback from Settings:{" "}
        <span className="font-mono">
          {registryLLMConnectionId || "-"} / {registryLLMModelId || "-"}
        </span>
      </div>
    </Card>
  );
}

function FieldLabel({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <Label>{label}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label={`About ${label}`}
          >
            <MessageQuestionCircle size={14} />
          </button>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          {hint}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}
