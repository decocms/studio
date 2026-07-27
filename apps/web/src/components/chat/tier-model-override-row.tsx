import { Suspense, useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import type { TranslationKey } from "@/i18n/en/index.ts";
import type { ChatTier } from "@decocms/shared/organization/schema";
import {
  useAiProviderKeys,
  type AiProviderModel,
} from "@/hooks/collections/use-ai-providers";
import type { ModelSlot } from "@/hooks/use-organization-settings";
import { ModelSelectorContentFallback } from "./select-model/decopilot";
import { ModelSelectorStandaloneBody } from "./select-model/index";

function slotToModel(
  slot: ModelSlot | null,
  providerId: AiProviderModel["providerId"],
): AiProviderModel | null {
  if (!slot) return null;
  return {
    modelId: slot.modelId,
    title: slot.title ?? slot.modelId,
    keyId: slot.keyId,
    providerId,
    description: null,
    logo: null,
    capabilities: [],
    limits: null,
    costs: null,
  };
}

const TIER_LABEL_KEY: Record<ChatTier, TranslationKey> = {
  fast: "chat.tierTrigger.tierFast",
  smart: "chat.tierTrigger.tierSmart",
  thinking: "chat.tierTrigger.tierThinking",
};

/**
 * A tier's personal model override, picked straight from the real model
 * picker body — reused as-is (not re-implemented) so this stays one source
 * of truth for browsing/searching models.
 */
export function TierModelOverridePicker({
  tier,
  orgSlot,
  userSlot,
  autoSlot,
  onPick,
  onReset,
  onClose,
}: {
  tier: ChatTier;
  orgSlot: ModelSlot | null;
  userSlot: ModelSlot | null | undefined;
  /** Server-mirrored auto-pick, used when neither org nor user has an
   *  explicit slot — so the picker opens on the provider a run would
   *  actually use instead of an arbitrary connected key. */
  autoSlot: ModelSlot | null | undefined;
  onPick: (slot: ModelSlot) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const allKeys = useAiProviderKeys();
  const effective = userSlot ?? orgSlot ?? autoSlot ?? null;
  // Which provider key's catalog the picker is browsing. Seeded from the
  // effective slot; the parent remounts this component when that slot
  // changes, so it can't outlive the value it was seeded from.
  const [localCredentialId, setLocalCredentialId] = useState<string | null>(
    effective?.keyId ?? allKeys[0]?.id ?? null,
  );
  const activeKeyId = localCredentialId ?? effective?.keyId ?? null;
  const slotKey = activeKeyId
    ? allKeys.find((k) => k.id === activeKeyId)
    : null;

  return (
    <div className="flex h-[70vh] max-h-[460px] w-full flex-col">
      <div className="flex items-center justify-between px-3 h-8 shrink-0">
        <span className="text-xs font-medium text-muted-foreground">
          {t(TIER_LABEL_KEY[tier])}
        </span>
        {userSlot && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-accent cursor-pointer"
          >
            {t("chat.modelPreferences.reset")}
          </button>
        )}
      </div>
      <div className="flex-1 min-h-0">
        <Suspense fallback={<ModelSelectorContentFallback />}>
          <ModelSelectorStandaloneBody
            compact
            onClose={onClose}
            credentialId={activeKeyId}
            onCredentialChange={setLocalCredentialId}
            selectedModel={slotToModel(
              effective,
              slotKey?.providerId ?? "deco",
            )}
            onModelChange={(m) => {
              const keyId = m.keyId ?? activeKeyId ?? "";
              setLocalCredentialId(keyId);
              onPick({ keyId, modelId: m.modelId, title: m.title });
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
