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

// ── Default Models ───────────────────────────────────────────────────

const filterImageModels = (m: AiProviderModel) =>
  m.capabilities?.includes("image") === true;

const filterWebResearchModels = (m: AiProviderModel) => {
  if (m.asyncResearch === true) return true;
  const n = m.modelId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return n.includes("sonar") || n.includes("deepresearch");
};

const TIER_ROWS = [
  {
    key: "fast" as const,
    label: "Fast",
    description: "Fastest responses, best for quick tasks",
    filter: undefined,
  },
  {
    key: "smart" as const,
    label: "Smart",
    description: "Balanced speed and capability",
    filter: undefined,
  },
  {
    key: "thinking" as const,
    label: "Thinking",
    description: "Most capable, best for complex tasks",
    filter: undefined,
  },
  {
    key: "image" as const,
    label: "Image",
    description: "Image generation",
    filter: filterImageModels,
  },
  {
    key: "web_research" as const,
    label: "Web research",
    description: "Web search and deep research",
    filter: filterWebResearchModels,
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
    ? ({
        modelId: slot.modelId,
        title: slot.title ?? slot.modelId,
        keyId: slot.keyId,
        providerId: slotKey?.providerId ?? "deco",
        description: null,
        logo: null,
        capabilities: [],
        limits: null,
        costs: null,
      } as AiProviderModel)
    : null;

  if (filterModels && !hasFilteredModels) {
    return (
      <p className="text-xs text-muted-foreground italic">
        Not available with current provider
      </p>
    );
  }

  return (
    <ModelSelector
      variant="bordered"
      placeholder="Pick model"
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
  if (isPending) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <RefreshCw01 size={12} className="animate-spin" />
        Saving…
      </span>
    );
  }
  if (showSaved) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <CheckCircle size={12} />
        Saved
      </span>
    );
  }
  return null;
}

export function SimpleModeSection() {
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
          toast.error(`Failed to save: ${err.message}`);
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
          web_research: null,
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
      web_research: isStale(current.tiers.web_research)
        ? null
        : current.tiers.web_research,
    };

    const needsFill =
      !clearedTiers.fast ||
      !clearedTiers.smart ||
      !clearedTiers.thinking ||
      !clearedTiers.image ||
      !clearedTiers.web_research;

    const tiersUnchanged =
      clearedTiers.fast === current.tiers.fast &&
      clearedTiers.smart === current.tiers.smart &&
      clearedTiers.thinking === current.tiers.thinking &&
      clearedTiers.image === current.tiers.image &&
      clearedTiers.web_research === current.tiers.web_research;

    if (!needsFill && tiersUnchanged) return;

    const defaults = pickSimpleModeDefaults(allKeys, modelsByKeyId);
    form.reset(
      {
        tiers: {
          fast: clearedTiers.fast ?? defaults.chat.fast,
          smart: clearedTiers.smart ?? defaults.chat.smart,
          thinking: clearedTiers.thinking ?? defaults.chat.thinking,
          image: clearedTiers.image ?? defaults.image,
          web_research: clearedTiers.web_research ?? defaults.webResearch,
        },
      },
      { keepDirty: true },
    );
  }, [form, allKeys, models0, models1, models2, key0?.id, key1?.id, key2?.id]);

  return (
    <SettingsSection title="Default models" headerClassName="pl-0">
      <div className="flex items-center justify-between -mt-2 mb-2">
        <p className="text-sm text-muted-foreground">
          These models power chat, automations, and tools across your
          organization.
        </p>
        <AutosaveStatus
          isPending={isPending}
          showSaved={isSuccess && !isDirty}
        />
      </div>
      <SettingsCard>
        {TIER_ROWS.map((row) => (
          <Controller
            key={row.key}
            control={form.control}
            name={`tiers.${row.key}` as const}
            render={({ field }) => (
              <SettingsCardItem
                title={row.label}
                description={row.description}
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
