import { useState, useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { RefreshCw01, CheckCircle } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import {
  useAiProviderKeys,
  useAiProviderModels,
  type AiProviderModel,
} from "@/web/hooks/collections/use-ai-providers";
import {
  isDeepResearchModel,
  isQuickSearchModel,
  pickSimpleModeDefaults,
  type SimpleModeModelSlot,
} from "@decocms/mesh-sdk";
import {
  useSimpleMode,
  useUpdateSimpleMode,
  type SimpleModeConfig,
} from "@/web/hooks/use-organization-settings";
import { SimpleModeConfigSchema } from "@/tools/organization/schema";
import { ModelSelector } from "@/web/components/chat/select-model";
import { useDebouncedAutosave } from "@/web/hooks/use-debounced-autosave.ts";
import { useT } from "@/web/i18n/use-t.ts";

// ── Default Models ───────────────────────────────────────────────────

const filterImageModels = (m: AiProviderModel) =>
  m.capabilities?.includes("image") === true;

// Quick web search vs deep research classifiers are shared with the chat
// picker and the SDK default-picker (`@decocms/mesh-sdk`) so the three never
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
  onSlotChange,
  filterModels,
  defaultKeyId,
}: {
  slot: SimpleModeModelSlot | null;
  onSlotChange: (slot: SimpleModeModelSlot | null) => void;
  filterModels?: (m: AiProviderModel) => boolean;
  defaultKeyId: string | null;
}) {
  const allKeys = useAiProviderKeys();
  const [localCredentialId, setLocalCredentialId] = useState<string | null>(
    slot?.keyId ?? defaultKeyId,
  );

  // oxlint-disable-next-line ban-use-effect/ban-use-effect
  useEffect(() => {
    if (slot?.keyId) setLocalCredentialId(slot.keyId);
  }, [slot?.keyId]);

  const activeKeyId = localCredentialId ?? defaultKeyId;
  const slotKey = activeKeyId
    ? allKeys.find((k) => k.id === activeKeyId)
    : null;

  const { models: activeModels, isLoading: isLoadingModels } =
    useAiProviderModels(filterModels ? (activeKeyId ?? undefined) : undefined);
  const hasFilteredModels = filterModels
    ? isLoadingModels || activeModels.some(filterModels)
    : true;

  const resolvedModel: AiProviderModel | null = slot
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

  if (filterModels && !hasFilteredModels) {
    return (
      <p className="text-xs text-muted-foreground italic">
        {t("settings.simpleModeSection.notAvailableWithCurrentProvider")}
      </p>
    );
  }

  return (
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
  const allKeys = useAiProviderKeys();
  const simpleMode = useSimpleMode();
  const hasProvider = allKeys.length > 0;

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

  // Autosave: 250ms after the last `schedule()` call, persist. The debounce
  // coalesces multi-field writes from Effect 2 into a single mutation.
  // We can't gate on `formState.isDirty` here: the `values: simpleMode` prop
  // resyncs the form on every cache update — clearing the flag before the timer
  // fires, swallowing the save. Each `schedule()` call is the explicit save
  // intent; nothing inside `save` re-schedules so there's no feedback loop.
  const { schedule: scheduleAutosave } = useDebouncedAutosave({
    delayMs: 250,
    save: async () => {
      const values = form.getValues();
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

  // Lazily load models for the first 3 keys so we can pre-fill defaults.
  // Hooks can't run in loops; capping at 3 is sufficient for defaults —
  // the user can always pick manually.
  const key0 = allKeys[0];
  const key1 = allKeys[1];
  const key2 = allKeys[2];
  const { models: models0 } = useAiProviderModels(key0?.id);
  const { models: models1 } = useAiProviderModels(key1?.id);
  const { models: models2 } = useAiProviderModels(key2?.id);

  // Effect 1: Clear form when all providers are removed.
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — reacts to async provider list changes
  useEffect(() => {
    if (!hasProvider) {
      form.reset({
        tiers: {
          fast: null,
          smart: null,
          thinking: null,
          image: null,
          web_search: null,
          deep_research: null,
        },
      });
    }
  }, [hasProvider, form]);

  // Effect 2: Fill null slots with defaults once models finish loading,
  // and clear slots whose keyId no longer exists in allKeys (stale provider).
  // oxlint-disable-next-line ban-use-effect/ban-use-effect — reacts to async model list loading
  useEffect(() => {
    const current = form.getValues();

    const validKeyIds = new Set(allKeys.map((k) => k.id));
    const modelsByKeyId: Record<string, AiProviderModel[]> = {};
    if (key0?.id) modelsByKeyId[key0.id] = models0;
    if (key1?.id) modelsByKeyId[key1.id] = models1;
    if (key2?.id) modelsByKeyId[key2.id] = models2;

    const isStale = (slot: SimpleModeModelSlot | null) =>
      slot != null && !validKeyIds.has(slot.keyId);

    const clearedTiers = {
      fast: isStale(current.tiers.fast) ? null : current.tiers.fast,
      smart: isStale(current.tiers.smart) ? null : current.tiers.smart,
      thinking: isStale(current.tiers.thinking) ? null : current.tiers.thinking,
      image: isStale(current.tiers.image) ? null : current.tiers.image,
      web_search: isStale(current.tiers.web_search)
        ? null
        : current.tiers.web_search,
      deep_research: isStale(current.tiers.deep_research)
        ? null
        : current.tiers.deep_research,
    };

    const needsFill =
      !clearedTiers.fast ||
      !clearedTiers.smart ||
      !clearedTiers.thinking ||
      !clearedTiers.image ||
      !clearedTiers.web_search ||
      !clearedTiers.deep_research;

    const tiersUnchanged =
      clearedTiers.fast === current.tiers.fast &&
      clearedTiers.smart === current.tiers.smart &&
      clearedTiers.thinking === current.tiers.thinking &&
      clearedTiers.image === current.tiers.image &&
      clearedTiers.web_search === current.tiers.web_search &&
      clearedTiers.deep_research === current.tiers.deep_research;

    if (!needsFill && tiersUnchanged) return;

    const defaults = pickSimpleModeDefaults(allKeys, modelsByKeyId);
    form.reset(
      {
        tiers: {
          fast: clearedTiers.fast ?? defaults.chat.fast,
          smart: clearedTiers.smart ?? defaults.chat.smart,
          thinking: clearedTiers.thinking ?? defaults.chat.thinking,
          image: clearedTiers.image ?? defaults.image,
          web_search: clearedTiers.web_search ?? defaults.webSearch,
          deep_research: clearedTiers.deep_research ?? defaults.deepResearch,
        },
      },
      { keepDirty: true },
    );
  }, [form, allKeys, models0, models1, models2, key0?.id, key1?.id, key2?.id]);

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

  const getTierDescription = (tierKey: string) => {
    const descriptions: Record<string, string> = {
      fast: t("settings.simpleModeSection.tierFastDesc"),
      smart: t("settings.simpleModeSection.tierSmartDesc"),
      thinking: t("settings.simpleModeSection.tierThinkingDesc"),
      image: t("settings.simpleModeSection.tierImageDesc"),
      web_search: t("settings.simpleModeSection.tierWebSearchDesc"),
      deep_research: t("settings.simpleModeSection.tierDeepResearchDesc"),
    };
    return descriptions[tierKey] || "";
  };

  return (
    <SettingsSection
      title={t("settings.simpleModeSection.defaultModels")}
      headerClassName="pl-0"
    >
      <div className="flex items-center justify-between -mt-2 mb-2">
        <p className="text-sm text-muted-foreground">
          {t("settings.simpleModeSection.modelsPowerDescription")}
        </p>
        <AutosaveStatus
          isPending={isPending}
          showSaved={isSuccess && !isDirty}
        />
      </div>
      <SettingsCard>
        {TIER_KEYS.map((row) => (
          <Controller
            key={row.key}
            control={form.control}
            name={`tiers.${row.key}` as const}
            render={({ field }) => (
              <SettingsCardItem
                title={getTierLabel(row.key)}
                description={getTierDescription(row.key)}
                action={
                  <SimpleModeModelRow
                    slot={field.value}
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
