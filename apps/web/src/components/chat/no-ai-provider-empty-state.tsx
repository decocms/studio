import { useState } from "react";
import { Monitor01 } from "@untitledui/icons";
import { ConnectProviderDialog } from "@/views/settings/ai-providers/connect-provider-dialog";
import {
  ProviderGrid,
  type ProviderSelection,
} from "@/views/settings/ai-providers/provider-grid";
import { useProjectContext } from "@/sdk";
import { useAiProviders } from "@/hooks/collections/use-ai-providers";
import { useT } from "@/i18n/use-t.ts";

interface NoAiProviderEmptyStateProps {
  title?: string;
  description?: string;
  /** Offer only the providers this accepts. */
  providerFilter?: (providerId: string) => boolean;
}

export function NoAiProviderEmptyState({
  title,
  description,
  providerFilter,
}: NoAiProviderEmptyStateProps = {}) {
  const t = useT();
  const { org } = useProjectContext();
  const [pendingProvider, setPendingProvider] =
    useState<ProviderSelection | null>(null);

  const aiProviders = useAiProviders();
  const providers = (aiProviders?.providers ?? []).filter(
    (provider) => !providerFilter || providerFilter(provider.id),
  );

  const orgName = org.name;

  const heading =
    title ??
    (orgName
      ? t("chat.noAiProviderEmptyState.headingWithOrg", { org: orgName })
      : t("chat.noAiProviderEmptyState.headingDefault"));
  const subtitle =
    description ?? t("chat.noAiProviderEmptyState.subtitleDefault");

  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-3xl px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex items-center justify-center size-14 rounded-2xl bg-muted border border-border">
          <Monitor01 size={24} className="text-muted-foreground" />
        </div>
        <div className="space-y-2">
          <p className="text-xl font-semibold text-foreground tracking-tight">
            {heading}
          </p>
          <p className="text-sm text-muted-foreground max-w-md">{subtitle}</p>
        </div>
      </div>

      <div className="w-full">
        <ProviderGrid
          providers={providers}
          onSelect={(selection) => setPendingProvider(selection)}
        />
      </div>

      <ConnectProviderDialog
        open={pendingProvider !== null}
        onOpenChange={(o) => {
          if (!o) {
            setPendingProvider(null);
          }
        }}
        initialProvider={pendingProvider ?? undefined}
      />
    </div>
  );
}
