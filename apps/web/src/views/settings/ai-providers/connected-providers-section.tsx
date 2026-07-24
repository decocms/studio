import { Plus } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-section";
import {
  useAiProviderKeys,
  useAiProviders,
} from "@/hooks/collections/use-ai-providers";
import { useT } from "@/i18n/use-t.ts";
import { ProviderKeyRow } from "./provider-key-row";

interface ConnectedProvidersSectionProps {
  onConnectClick: () => void;
}

export function ConnectedProvidersSection({
  onConnectClick,
}: ConnectedProvidersSectionProps) {
  const t = useT();
  const allKeys = useAiProviderKeys();
  const aiProviders = useAiProviders();
  const providers = aiProviders?.providers ?? [];

  // Show every key except Deco — Deco lives in its own hero/nudge slot.
  const rows = allKeys
    .filter((k) => k.providerId !== "deco")
    .map((key) => ({
      key,
      provider: providers.find((p) => p.id === key.providerId),
    }))
    .filter(
      (
        row,
      ): row is {
        key: typeof row.key;
        provider: NonNullable<typeof row.provider>;
      } => row.provider !== undefined,
    );

  return (
    <SettingsSection
      title={t("settings.connectedProvidersSection.sectionTitle")}
      headerClassName="px-0"
      actions={
        <Button size="sm" onClick={onConnectClick}>
          <Plus size={14} />
          {t("settings.connectedProvidersSection.connectButton")}
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1">
          {t("settings.connectedProvidersSection.emptyState")}
        </p>
      ) : (
        <SettingsCard>
          {rows.map(({ key, provider }) => (
            <ProviderKeyRow
              key={key.id}
              providerKey={key}
              provider={provider}
            />
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
