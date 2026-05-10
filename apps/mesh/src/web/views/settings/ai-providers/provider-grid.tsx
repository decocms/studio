import type { AiProviderInfo } from "@decocms/mesh-sdk";
import { Avatar } from "@deco/ui/components/avatar.tsx";
import {
  SettingsCard,
  SettingsCardItem,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import {
  OPENAI_COMPATIBLE_PRESETS,
  type OpenAICompatiblePreset,
} from "@/web/utils/openai-compatible-presets";

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
          <img
            src={logo}
            alt={name}
            className="size-8 rounded-md object-contain dark:bg-white dark:p-0.5"
          />
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

export function ProviderGrid({ providers, onSelect }: ProviderGridProps) {
  // "deco" is reached via the nudge / empty-state CTA, not the grid.
  const visible = providers.filter((p) => p.id !== "deco");
  const local = visible.filter((p) =>
    p.supportedMethods.includes("cli-activate"),
  );
  const cloud = visible.filter(
    (p) =>
      !p.supportedMethods.includes("cli-activate") &&
      p.id !== "openai-compatible",
  );
  const openaiCompatible = visible.find((p) => p.id === "openai-compatible");

  return (
    <div className="flex flex-col gap-6">
      {local.length > 0 && (
        <SettingsSection>
          <div className="relative rounded-xl border border-lime-400/30 bg-gradient-to-br from-lime-50/50 via-transparent to-yellow-50/30 dark:from-lime-950/20 dark:to-yellow-950/10 p-4">
            <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-lime-400/5 to-yellow-400/5 pointer-events-none" />
            <p className="text-xs font-medium text-lime-700 dark:text-lime-400 mb-3 relative">
              Local models — use your existing AI provider
            </p>
            <SettingsCard className="relative">
              {local.map((provider) => (
                <ProviderTile
                  key={provider.id}
                  logo={provider.logo}
                  name={provider.name}
                  description={provider.description}
                  onClick={() => onSelect({ kind: "provider", provider })}
                />
              ))}
            </SettingsCard>
          </div>
        </SettingsSection>
      )}

      <SettingsSection>
        <SettingsCard>
          {[
            ...cloud.map((provider) => (
              <ProviderTile
                key={provider.id}
                logo={provider.logo}
                name={provider.name}
                description={provider.description}
                onClick={() => onSelect({ kind: "provider", provider })}
              />
            )),
            ...(openaiCompatible
              ? [
                  ...OPENAI_COMPATIBLE_PRESETS.map((preset) => (
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
                  )),
                  <ProviderTile
                    key="custom"
                    logo={openaiCompatible.logo}
                    name="Custom OpenAI-compatible"
                    description="Connect any OpenAI-compatible endpoint by URL"
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
          ]}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
