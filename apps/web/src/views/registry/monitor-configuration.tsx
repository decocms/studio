import { useRef, useState } from "react";
import { Badge } from "@deco/ui/components/badge.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { Card } from "@deco/ui/components/card.tsx";
import { Input } from "@deco/ui/components/input.tsx";
import { Label } from "@deco/ui/components/label.tsx";
import { Textarea } from "@deco/ui/components/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { MessageQuestionCircle } from "@untitledui/icons";
import { useT } from "@/i18n/use-t.ts";
import { useRegistryMonitorConfig } from "@/hooks/registry/use-monitor";
import type {
  MonitorFailureAction,
  RegistryMonitorConfig,
} from "@/lib/registry/types";
import { MONITOR_AGENT_DEFAULT_SYSTEM_PROMPT } from "@decocms/shared/registry/constants";

function hasChanges(
  a: RegistryMonitorConfig,
  b: RegistryMonitorConfig,
): boolean {
  return (
    a.onFailure !== b.onFailure ||
    a.perMcpTimeoutMs !== b.perMcpTimeoutMs ||
    a.perToolTimeoutMs !== b.perToolTimeoutMs ||
    a.maxAgentSteps !== b.maxAgentSteps ||
    a.testPublicOnly !== b.testPublicOnly ||
    a.testPrivateOnly !== b.testPrivateOnly ||
    a.includePendingRequests !== b.includePendingRequests ||
    (a.agentContext ?? "") !== (b.agentContext ?? "")
  );
}

export function MonitorConfiguration() {
  const t = useT();
  const { settings, saveMutation } = useRegistryMonitorConfig();
  const prevSettingsRef = useRef(settings);
  const [draft, setDraft] = useState<RegistryMonitorConfig>(settings);
  const [justSaved, setJustSaved] = useState(false);
  const [showDefaultPrompt, setShowDefaultPrompt] = useState(false);

  // Sync draft when external settings change (replaces useEffect)
  // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
  if (prevSettingsRef.current !== settings) {
    // oxlint-disable-next-line ban-ref-current-assignment/ban-ref-current-assignment -- TODO: refactor render-time .current access
    prevSettingsRef.current = settings;
    setDraft(settings);
  }

  const isDirty = hasChanges(draft, settings);

  const setPartial = (patch: Partial<RegistryMonitorConfig>) => {
    setJustSaved(false);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  const save = async () => {
    const nextDraft: RegistryMonitorConfig = {
      ...draft,
      agentContext: (draft.agentContext ?? "").trim(),
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
          <h3 className="text-sm font-semibold">
            {t("registry.monitorConfiguration.qaConfiguration")}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t("registry.monitorConfiguration.description")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isDirty && (
            <Badge className="bg-warning/10 text-warning border-warning/20 text-[10px]">
              {t("registry.monitorConfiguration.unsavedChanges")}
            </Badge>
          )}
          {justSaved && (
            <Badge className="bg-success/10 text-success border-success/20 text-[10px]">
              ✓ {t("registry.monitorConfiguration.saved")}
            </Badge>
          )}
          <Button
            size="sm"
            onClick={save}
            disabled={saveMutation.isPending || !isDirty}
          >
            {saveMutation.isPending
              ? t("registry.monitorConfiguration.saving")
              : t("registry.monitorConfiguration.saveSettings")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="space-y-1">
          <FieldLabel
            label={t("registry.monitorConfiguration.onFailureLabel")}
            hint={t("registry.monitorConfiguration.onFailureHint")}
          />
          <select
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            value={draft.onFailure}
            onChange={(e) =>
              setPartial({ onFailure: e.target.value as MonitorFailureAction })
            }
          >
            <option value="none">
              {t("registry.monitorConfiguration.onFailureNone")}
            </option>
            <option value="unlisted">
              {t("registry.monitorConfiguration.onFailureUnlisted")}
            </option>
            <option value="remove_public">
              {t("registry.monitorConfiguration.onFailureRemovePublic")}
            </option>
            <option value="remove_private">
              {t("registry.monitorConfiguration.onFailureRemovePrivate")}
            </option>
            <option value="remove_all">
              {t("registry.monitorConfiguration.onFailureRemoveAll")}
            </option>
          </select>
        </div>

        <div className="space-y-1">
          <FieldLabel
            label={t("registry.monitorConfiguration.testScopeLabel")}
            hint={t("registry.monitorConfiguration.testScopeHint")}
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
              {t("registry.monitorConfiguration.publicOnly")}
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
              {t("registry.monitorConfiguration.privateOnly")}
            </label>
          </div>
        </div>

        <div className="space-y-1">
          <FieldLabel
            label={t("registry.monitorConfiguration.publishRequestsLabel")}
            hint={t("registry.monitorConfiguration.publishRequestsHint")}
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
              {t("registry.monitorConfiguration.includePendingRequests")}
            </label>
          </div>
        </div>

        <div className="space-y-1 md:col-span-2">
          <div className="flex items-center justify-between gap-2">
            <FieldLabel
              label={t(
                "registry.monitorConfiguration.additionalTestContextLabel",
              )}
              hint={t(
                "registry.monitorConfiguration.additionalTestContextHint",
              )}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => setShowDefaultPrompt((prev) => !prev)}
            >
              {showDefaultPrompt
                ? t("registry.monitorConfiguration.hideDefaultPrompt")
                : t("registry.monitorConfiguration.viewDefaultPrompt")}{" "}
              {t("registry.monitorConfiguration.defaultSystemPrompt")}
            </Button>
          </div>
          <Textarea
            value={draft.agentContext ?? ""}
            onChange={(e) => setPartial({ agentContext: e.target.value })}
            placeholder={t(
              "registry.monitorConfiguration.agentContextPlaceholder",
            )}
            rows={3}
          />
          <p className="text-[11px] text-muted-foreground">
            {t("registry.monitorConfiguration.agentContextHelper")}
          </p>
          {showDefaultPrompt && (
            <pre className="text-[11px] bg-muted/50 border border-border rounded px-3 py-2 whitespace-pre-wrap max-h-64 overflow-auto">
              {MONITOR_AGENT_DEFAULT_SYSTEM_PROMPT}
            </pre>
          )}
        </div>

        <div className="space-y-1">
          <FieldLabel
            label={t("registry.monitorConfiguration.perMcpTimeoutLabel")}
            hint={t("registry.monitorConfiguration.perMcpTimeoutHint")}
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
            label={t("registry.monitorConfiguration.perToolTimeoutLabel")}
            hint={t("registry.monitorConfiguration.perToolTimeoutHint")}
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
            label={t("registry.monitorConfiguration.maxAgentStepsLabel")}
            hint={t("registry.monitorConfiguration.maxAgentStepsHint")}
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
    </Card>
  );
}

function FieldLabel({ label, hint }: { label: string; hint: string }) {
  const t = useT();
  return (
    <div className="flex items-center gap-1.5">
      <Label>{label}</Label>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label={t("registry.monitorConfiguration.aboutLabel", {
              label,
            })}
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
