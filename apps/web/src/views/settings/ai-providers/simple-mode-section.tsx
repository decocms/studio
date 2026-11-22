import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { RefreshCw01, CheckCircle } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  useAutoSimpleModeDefaults,
  useHostedAiProviderKeys,
  useAiProviderModels,
  type AiProviderModel,
} from "@/hooks/collections/use-ai-providers";
import {
  isDeepResearchModel,
  isQuickSearchModel,
  type SimpleModeModelSlot,
} from "@/sdk";
import {
  useSimpleMode,
  useUpdateSimpleMode,
  type SimpleModeConfig,
} from "@/hooks/use-organization-settings";
import { SimpleModeConfigSchema } from "@decocms/shared/organization/schema";
import { ModelSelector } from "@/components/chat/select-model";
import { useDebouncedAutosave } from "@/hooks/use-debounced-autosave.ts";
import { useT } from "@/i18n/use-t.ts";
import { simpleModeToPersist, tierDisplay } from "./simple-mode-form";

// ── Default Models ───────────────────────────────────────────────────

const filterImageModels = (m: AiProviderModel) =>
  m.capabilities?.includes("image") === true;

// Quick web search vs deep research classifiers are shared with the chat
// picker and the SDK default-picker (`@/sdk`) so the three never
// drift. Quick = search-capable but not async-only (pinning an async model
// here would make every quick lookup launch a slow research job); deep =
// async / deep-research, with sonar-pro allowed as a capable fallback.
const filterWebSearchModels = (m: AiProviderModel) => isQuickSearchModel(m);
const filterDeepResearchModels = (m: AiProviderModel) => isDeepResearchModel(m);

const TIER_KEYS = [
  {
    key: "fast" as const,
    filter: undefined,
  },
  {
    key: "smart" as const,
    filter: undefined,
  },
  {
    key: "thinking" as const,
    filter: undefined,
  },
  {
    key: "image" as const,
    filter: filterImageModels,
  },
  {
    key: "web_search" as const,
    filter: filterWebSearchModels,
  },
  {
    key: "deep_research" as const,
    filter: filterDeepResearchModels,
  },
] as const;

function SimpleModeModelRow({
  slot,
  followsDefault,
  onSlotChange,
  filterModels,
  defaultKeyId,
}: {
  /** The model to name: the admin's choice, or today's default pick. */
  slot: SimpleModeModelSlot | null;
  followsDefault: boolean;
  onSlotChange: (slot: SimpleModeModelSlot | null) => void;
  filterModels?: (m: AiProviderModel) => boolean;
  defaultKeyId: string | null;
}) {
  const allKeys = useHostedAiProviderKeys();
  const slotKeyId = allKeys.some((key) => key.id === slot?.keyId)
    ? slot?.keyId
    : null;
  const [localCredentialId, setLocalCredentialId] = useState<string | null>(
    slotKeyId ?? defaultKeyId,
  );

  // Adopt the slot's key whenever the slot changes to a real one, without an
  // effect: adjusting state during render is React's documented answer here.
  const [prevSlotKeyId, setPrevSlotKeyId] = useState(slotKeyId);
  if (prevSlotKeyId !== slotKeyId) {
    setPrevSlotKeyId(slotKeyId);
    if (slotKeyId) setLocalCredentialId(slotKeyId);
  }

  const activeKeyId = allKeys.some((key) => key.id === localCredentialId)
    ? localCredentialId
    : defaultKeyId;
  const slotKey = activeKeyId
    ? allKeys.find((k) => k.id === activeKeyId)
    : null;

  const { models: activeModels, isLoading: isLoadingModels } =
    useAiProviderModels(filterModels ? (activeKeyId ?? undefined) : undefined);
  const hasFilteredModels = filterModels
    ? isLoadingModels || activeModels.some(filterModels)
    : true;

  const resolvedModel: AiProviderModel | null =
    slot && slotKeyId
      ? {
          modelId: slot.modelId,
          title: slot.title ?? slot.modelId,
          keyId: slot.keyId,
          providerId: slotKey?.providerId ?? "deco",
          description: null,
          logo: null,
          capabilities: [],
          limits: null,
          costs: null,
        }
      : null;

  const t = useT();

  const resetButton = followsDefault ? null : (
    <Button variant="ghost" size="sm" onClick={() => onSlotChange(null)}>
      {t("settings.simpleModeSection.useDefault")}
    </Button>
  );

  if (filterModels && !hasFilteredModels) {
    return (
      <div className="flex items-center gap-2">
        {resetButton}
        <p className="text-xs text-muted-foreground italic">
          {t("settings.simpleModeSection.notAvailableWithCurrentProvider")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {resetButton}
      {followsDefault && resolvedModel && (
        <Badge variant="muted">
          {t("settings.simpleModeSection.defaultBadge")}
        </Badge>
      )}
      <ModelSelector
        variant="bordered"
        placeholder={t("settings.simpleModeSection.pickModel")}
        model={resolvedModel}
        credentialId={activeKeyId}
        filterModels={filterModels}
        onCredentialChange={(keyId) => setLocalCredentialId(keyId)}
        onModelChange={(m) => {
          const keyId = m.keyId ?? activeKeyId ?? "";
          setLocalCredentialId(keyId);
          onSlotChange({ keyId, modelId: m.modelId, title: m.title });
        }}
      />
    </div>
  );
}

function AutosaveStatus({
  isPending,
  showSaved,
}: {
  isPending: boolean;
  showSaved: boolean;
}) {
  const t = useT();

  if (isPending) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <RefreshCw01 size={12} className="animate-spin" />
        {t("settings.simpleModeSection.saving")}
      </span>
    );
  }
  if (showSaved) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <CheckCircle size={12} />
        {t("settings.simpleModeSection.saved")}
      </span>
    );
  }
  return null;
}

export function SimpleModeSection() {
  const t = useT();
  const allKeys = useHostedAiProviderKeys();
  const simpleMode = useSimpleMode();
  const defaults = useAutoSimpleModeDefaults(allKeys);
  const availableKeyIds = new Set(allKeys.map((key) => key.id));

  const form = useForm<SimpleModeConfig>({
    resolver: zodResolver(SimpleModeConfigSchema),
    values: simpleMode,
    mode: "onChange",
  });

  const {
    mutate: updateSimpleMode,
    isPending,
    isSuccess,
  } = useUpdateSimpleMode();

  const isDirty = form.formState.isDirty;

  // Autosave: 250ms after the last `schedule()` call, persist.
  // We can't gate on `formState.isDirty` here: the `values: simpleMode` prop
  // resyncs the form on every cache update — clearing the flag before the timer
  // fires, swallowing the save. Each `schedule()` call is the explicit save
  // intent; nothing inside `save` re-schedules so there's no feedback loop.
  const { schedule: scheduleAutosave } = useDebouncedAutosave({
    delayMs: 250,
    save: async () => {
      const values = simpleModeToPersist(form.getValues(), availableKeyIds);
      updateSimpleMode(values, {
        onSuccess: () => form.reset(values, { keepValues: true }),
        onError: (err) => {
          form.reset(simpleMode);
          toast.error(
            t("settings.simpleModeSection.failedToSave", {
              error: err.message,
            }),
          );
        },
      });
    },
  });

  const getTierLabel = (tierKey: string) => {
    const labels: Record<string, string> = {
      fast: t("settings.simpleModeSection.tierFast"),
      smart: t("settings.simpleModeSection.tierSmart"),
      thinking: t("settings.simpleModeSection.tierThinking"),
      image: t("settings.simpleModeSection.tierImage"),
      web_search: t("settings.simpleModeSection.tierWebSearch"),
      deep_research: t("settings.simpleModeSection.tierDeepResearch"),
    };
    return labels[tierKey] || tierKey;
  };

  return (
    <SettingsSection
      title={t("settings.simpleModeSection.defaultModels")}
      description={t("settings.simpleModeSection.description")}
      actions={
        <AutosaveStatus
          isPending={isPending}
          showSaved={isSuccess && !isDirty}
        />
      }
    >
      <SettingsCard>
        {TIER_KEYS.map((row) => (
          <Controller
            key={row.key}
            control={form.control}
            name={`tiers.${row.key}` as const}
            render={({ field }) => (
              <SettingsCardItem
                title={getTierLabel(row.key)}
                action={
                  <SimpleModeModelRow
                    {...tierDisplay(
                      row.key,
                      field.value,
                      defaults,
                      availableKeyIds,
                    )}
                    defaultKeyId={allKeys[0]?.id ?? null}
                    filterModels={row.filter}
                    onSlotChange={(slot) => {
                      field.onChange(slot);
                      scheduleAutosave();
                    }}
                  />
                }
              />
            )}
          />
        ))}
      </SettingsCard>
    </SettingsSection>
  );
}
