import type { AiProviderInfo } from "@/sdk";
import { useState } from "react";
import { ChevronRight } from "@untitledui/icons";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  getPreset,
  OPENAI_COMPATIBLE_PRESETS,
  type OpenAICompatiblePreset,
} from "@/utils/openai-compatible-presets";
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
  /** When provided, cloud section is capped at 4 tiles with a "see all" row. */
  onShowAll?: () => void;
}

const CLOUD_PREVIEW_COUNT = 4;

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
  // Keyed by src so a new logo gets a fresh attempt without an effect.
  const [failedLogo, setFailedLogo] = useState<string | null>(null);
  const showLogo = logo && failedLogo !== logo;
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

  return (
    <SettingsCardItem
      onClick={onClick}
      icon={
        // Logos are drawn for light backgrounds, so the tile is white in both modes.
        <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-(--radius-s) bg-white p-1 text-xs font-medium text-black shadow-(--edge)">
          {showLogo ? (
            <img
              src={logo}
              alt={name}
              className="size-full object-contain"
              onError={() => setFailedLogo(logo)}
            />
          ) : (
            <span aria-hidden="true">{initials}</span>
          )}
        </span>
      }
      title={name}
      description={description}
    />
  );
}

export function ProviderGrid({
  providers,
  onSelect,
  onShowAll,
}: ProviderGridProps) {
  const t = useT();
  const deco = providers.find((p) => p.id === "deco");
  const CLOUD_ORDER: Record<string, number> = {
    openrouter: 0,
    llmapi: 1,
    anthropic: 2,
    google: 3,
  };
  const cloud = providers
    .filter((p) => p.id !== "deco" && p.id !== "openai-compatible")
    .sort((a, b) => {
      const ai = CLOUD_ORDER[a.id] ?? Number.MAX_SAFE_INTEGER;
      const bi = CLOUD_ORDER[b.id] ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  const openaiCompatible = providers.find((p) => p.id === "openai-compatible");
  const openaiPreset = getPreset("openai");

  const allCloudTiles = [
    ...cloud.map((provider) => (
      <ProviderTile
        key={provider.id}
        logo={provider.logo}
        name={provider.name}
        description={provider.description}
        onClick={() => onSelect({ kind: "provider", provider })}
      />
    )),
    ...(openaiCompatible && openaiPreset
      ? [
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
        ]
      : []),
    ...(openaiCompatible
      ? [
          ...OPENAI_COMPATIBLE_PRESETS.filter((p) => p.id !== "openai").map(
            (preset) => (
              <ProviderTile
                key={preset.id}
                logo={preset.logo}
                name={preset.name}
                description={preset.description}
                onClick={() =>
                  onSelect({
                    kind: "openai-compatible",
                    provider: openaiCompatible,
                    preset,
                  })
                }
              />
            ),
          ),
          <ProviderTile
            key="custom"
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
          />,
        ]
      : []),
  ];

  const hiddenCount = allCloudTiles.length - CLOUD_PREVIEW_COUNT;
  const shouldPreview = !!onShowAll && hiddenCount > 0;
  const visibleCloudTiles = shouldPreview
    ? allCloudTiles.slice(0, CLOUD_PREVIEW_COUNT)
    : allCloudTiles;

  return (
    <div className="flex flex-col gap-6">
      {deco && (
        <SettingsSection>
          <div className="relative rounded-m border border-special/30 bg-gradient-to-br from-special/5 via-transparent to-palette-1/10 p-1.5">
            <div className="absolute inset-0 rounded-m bg-gradient-to-br from-special/5 to-palette-1/5 pointer-events-none" />
            <p className="text-xs font-medium text-special mb-1.5 px-2 pt-2 relative">
              {t("settings.aiProviders.recommended")}
            </p>
            <SettingsCard className="relative">
              <ProviderTile
                logo={deco.logo}
                name={deco.name}
                description={deco.description}
                onClick={() => onSelect({ kind: "provider", provider: deco })}
              />
            </SettingsCard>
          </div>
        </SettingsSection>
      )}

      <SettingsSection>
        <SettingsCard>
          {visibleCloudTiles}
          {shouldPreview && (
            <SettingsCardItem
              onClick={onShowAll}
              title={t(
                hiddenCount === 1
                  ? "settings.aiProviders.moreProvidersSingular"
                  : "settings.aiProviders.moreProvidersPlural",
                { count: hiddenCount },
              )}
              action={
                <ChevronRight size={16} className="text-muted-foreground" />
              }
            />
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
