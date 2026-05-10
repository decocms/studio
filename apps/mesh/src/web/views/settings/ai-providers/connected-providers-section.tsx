import { Plus } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import {
  SettingsCard,
  SettingsSection,
} from "@/web/components/settings/settings-section";
import {
  useAiProviderKeys,
  useAiProviders,
} from "@/web/hooks/collections/use-ai-providers";
import { ProviderKeyRow } from "./provider-key-row";

interface ConnectedProvidersSectionProps {
  onConnectClick: () => void;
}

export function ConnectedProvidersSection({
  onConnectClick,
}: ConnectedProvidersSectionProps) {
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
      title="Connected providers"
      headerClassName="px-0"
      actions={
        <Button size="sm" onClick={onConnectClick}>
          <Plus size={14} />
          Connect provider
        </Button>
      }
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1">
          Bring your own keys to use specific models alongside Deco's gateway.
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
