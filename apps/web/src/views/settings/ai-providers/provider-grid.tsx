import type { ReactNode } from "react";
import type { AiProviderInfo } from "@/sdk";
import { Avatar } from "@decocms/ui/components/avatar.tsx";
import {
  SettingsCard,
  SettingsCardItem,
} from "@/components/settings/settings-section";
import {
  getPreset,
  type OpenAICompatiblePreset,
} from "@/utils/openai-compatible-presets";
import { usePlansEnabled } from "@/hooks/use-entitlements";
import { useT } from "@/i18n/use-t.ts";

export type ProviderSelection =
  | { kind: "provider"; provider: AiProviderInfo }
  | {
      kind: "openai-compatible";
      provider: AiProviderInfo;
      preset: OpenAICompatiblePreset | null;
    };

interface ProviderGridProps {
  providers: AiProviderInfo[];
  onSelect: (selection: ProviderSelection) => void;
}

/**
 * Chat runs on the Claude Code and Codex harnesses, so only providers that can
 * serve them belong under "chat". Gemini answers neither — it still powers
 * image generation and web search, so it is offered for that alone. Providers
 * in neither list (LLMAPI) are not offered; their existing keys stay listed.
 */
const CHAT_PROVIDER_IDS = ["anthropic", "openrouter"] as const;
const MEDIA_PROVIDER_IDS = ["google"] as const;

function ProviderTile({
  logo,
  name,
  description,
  onClick,
}: {
  logo?: string | null;
  name: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <SettingsCardItem
      onClick={onClick}
      icon={
        logo ? (
          <img src={logo} alt={name} className="size-5 object-contain" />
        ) : (
          <Avatar
            fallback={name.charAt(0)}
            className="size-8 bg-primary/10 text-primary"
          />
        )
      }
      title={name}
      description={description}
    />
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-meta">{label}</span>
      <SettingsCard>{children}</SettingsCard>
    </div>
  );
}

export function ProviderGrid({ providers, onSelect }: ProviderGridProps) {
  const t = useT();
  // With plans on, the deco gateway is the plan itself, not a key to add.
  const plansEnabled = usePlansEnabled();
  const byId = (id: string) => providers.find((p) => p.id === id);
  const deco = plansEnabled ? undefined : byId("deco");
  const openaiCompatible = byId("openai-compatible");
  const openaiPreset = getPreset("openai");

  const tile = (provider: AiProviderInfo) => (
    <ProviderTile
      key={provider.id}
      logo={provider.logo}
      name={provider.name}
      description={provider.description}
      onClick={() => onSelect({ kind: "provider", provider })}
    />
  );

  const chat = CHAT_PROVIDER_IDS.flatMap((id) => {
    const provider = byId(id);
    return provider ? [tile(provider)] : [];
  });
  if (openaiCompatible && openaiPreset) {
    chat.push(
      <ProviderTile
        key={openaiPreset.id}
        logo={openaiPreset.logo}
        name={openaiPreset.name}
        description={openaiPreset.description}
        onClick={() =>
          onSelect({
            kind: "openai-compatible",
            provider: openaiCompatible,
            preset: openaiPreset,
          })
        }
      />,
    );
  }
  const media = MEDIA_PROVIDER_IDS.flatMap((id) => {
    const provider = byId(id);
    return provider ? [tile(provider)] : [];
  });

  return (
    <div className="flex flex-col gap-5">
      {deco && <SettingsCard>{tile(deco)}</SettingsCard>}
      {chat.length > 0 && (
        <Group label={t("settings.aiProviders.groupChat")}>{chat}</Group>
      )}
      {media.length > 0 && (
        <Group label={t("settings.aiProviders.groupMedia")}>{media}</Group>
      )}
      {openaiCompatible && (
        <SettingsCard>
          <ProviderTile
            logo={openaiCompatible.logo}
            name={t("settings.aiProviders.customOpenAiCompatible")}
            description={t("settings.aiProviders.customOpenAiDescription")}
            onClick={() =>
              onSelect({
                kind: "openai-compatible",
                provider: openaiCompatible,
                preset: null,
              })
            }
          />
        </SettingsCard>
      )}
    </div>
  );
}
