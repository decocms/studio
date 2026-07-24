import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@deco/ui/components/dialog.tsx";
import { useState } from "react";
import { useT } from "@/i18n/use-t.ts";
import type { ChatTier } from "@decocms/shared/organization/schema";
import {
  useAiProviderKeys,
  type AiProviderModel,
} from "@/hooks/collections/use-ai-providers";
import {
  useSimpleMode,
  type ModelSlot,
} from "@/hooks/use-organization-settings";
import {
  useUpdateUserModelPreferences,
  useUserModelPreferences,
} from "@/hooks/use-user-model-preferences";
import { ModelSelector } from "./select-model";

const CHAT_TIERS: ChatTier[] = ["fast", "smart", "thinking"];

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

/** One tier row: pick a personal model, or reset to the org default. */
function PrefTierRow({
  tier,
  orgSlot,
  userSlot,
  onPick,
  onReset,
}: {
  tier: ChatTier;
  orgSlot: ModelSlot | null;
  userSlot: ModelSlot | null | undefined;
  onPick: (slot: ModelSlot) => void;
  onReset: () => void;
}) {
  const t = useT();
  const allKeys = useAiProviderKeys();
  const effective = userSlot ?? orgSlot;
  const [localCredentialId, setLocalCredentialId] = useState<string | null>(
    effective?.keyId ?? allKeys[0]?.id ?? null,
  );
  const activeKeyId = localCredentialId ?? effective?.keyId ?? null;
  const slotKey = activeKeyId
    ? allKeys.find((k) => k.id === activeKeyId)
    : null;

  const label =
    tier === "fast"
      ? t("chat.tierTrigger.tierFast")
      : tier === "smart"
        ? t("chat.tierTrigger.tierSmart")
        : t("chat.tierTrigger.tierThinking");
  const orgModelTitle = orgSlot?.title ?? orgSlot?.modelId;

  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground truncate">
          {userSlot
            ? t("chat.modelPreferences.orgDefaultIs", {
                model: orgModelTitle ?? t("chat.modelPreferences.autoPicked"),
              })
            : t("chat.modelPreferences.usingOrgDefault")}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {userSlot && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded-md hover:bg-accent cursor-pointer"
          >
            {t("chat.modelPreferences.reset")}
          </button>
        )}
        <ModelSelector
          variant="bordered"
          placeholder={t("chat.modelPreferences.pickModel")}
          model={slotToModel(effective, slotKey?.providerId ?? "deco")}
          credentialId={activeKeyId}
          onCredentialChange={(keyId) => setLocalCredentialId(keyId)}
          onModelChange={(m) => {
            const keyId = m.keyId ?? activeKeyId ?? "";
            setLocalCredentialId(keyId);
            onPick({ keyId, modelId: m.modelId, title: m.title });
          }}
        />
      </div>
    </div>
  );
}

/**
 * Lets a user override the org's chat tier → model mapping for themselves.
 * The org default is untouched; an unset tier falls back to it. Only surfaces
 * models the user's role is allowed to use (the picker filters server-side).
 */
export function UserModelPreferencesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const org = useSimpleMode();
  const user = useUserModelPreferences();
  const update = useUpdateUserModelPreferences();

  const setTier = (tier: ChatTier, slot: ModelSlot | null) => {
    update.mutate({ tiers: { ...user.tiers, [tier]: slot } });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("chat.modelPreferences.title")}</DialogTitle>
          <DialogDescription>
            {t("chat.modelPreferences.description")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col divide-y divide-border">
          {CHAT_TIERS.map((tier) => (
            <PrefTierRow
              key={tier}
              tier={tier}
              orgSlot={org.tiers[tier]}
              userSlot={user.tiers[tier]}
              onPick={(slot) => setTier(tier, slot)}
              onReset={() => setTier(tier, null)}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
