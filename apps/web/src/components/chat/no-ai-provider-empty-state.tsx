import { useState } from "react";
import { Monitor01 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { ConnectProviderDialog } from "@/views/settings/ai-providers/connect-provider-dialog";
import {
  ProviderGrid,
  type ProviderSelection,
} from "@/views/settings/ai-providers/provider-grid";
import { useProjectContext } from "@/sdk";
import { useAiProviders } from "@/hooks/collections/use-ai-providers";
import {
  DownloadAppDialog,
  isLinuxDesktopBrowser,
  isMacDesktopBrowser,
} from "@/components/download-app-dialog";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
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
  const [gridOpen, setGridOpen] = useState(false);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const isDesktopApp = useIsDesktopApp();
  // The acquisition path for browser users on a platform we ship a desktop
  // build for is the app itself, not the `bunx decocms link` CLI. On a
  // platform with no build there is nothing to offer.
  const offerDownload =
    (isMacDesktopBrowser() || isLinuxDesktopBrowser()) && !isDesktopApp;

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

  const badgeClass =
    "flex items-center justify-center size-14 rounded-2xl bg-muted border border-border";

  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-3xl px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        {offerDownload ? (
          <button
            type="button"
            onClick={() => setDownloadDialogOpen(true)}
            aria-label={t("downloadApp.openLabel")}
            className={cn(
              badgeClass,
              "cursor-pointer transition-colors hover:bg-accent",
            )}
          >
            <Monitor01 size={24} className="text-muted-foreground" />
          </button>
        ) : (
          <div className={badgeClass}>
            <Monitor01 size={24} className="text-muted-foreground" />
          </div>
        )}
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
          onShowAll={() => setGridOpen(true)}
        />
      </div>

      <ConnectProviderDialog
        open={pendingProvider !== null || gridOpen}
        onOpenChange={(o) => {
          if (!o) {
            setPendingProvider(null);
            setGridOpen(false);
          }
        }}
        initialProvider={pendingProvider ?? undefined}
      />

      <DownloadAppDialog
        open={downloadDialogOpen}
        onOpenChange={setDownloadDialogOpen}
      />
    </div>
  );
}
