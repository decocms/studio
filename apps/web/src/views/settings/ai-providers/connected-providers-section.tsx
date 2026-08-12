import { Plus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
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
import { buildProviderInventoryRows } from "./provider-inventory";

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

  // Keep historical credentials visible even after their providers leave the
  // hosted catalog, so organizations retain an inventory and deletion path.
  const rows = buildProviderInventoryRows(allKeys, providers);

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
