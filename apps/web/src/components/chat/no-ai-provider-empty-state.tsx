import { useState } from "react";
import { Monitor01 } from "@untitledui/icons";
import { EmptyState } from "@decocms/ui/components/empty-state.tsx";
import { ConnectProviderDialog } from "@/views/settings/ai-providers/connect-provider-dialog";
import {
  ProviderGrid,
  type ProviderSelection,
} from "@/views/settings/ai-providers/provider-grid";
import { useProjectContext } from "@/sdk";
import { useAiProviders } from "@/hooks/collections/use-ai-providers";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useQuery } from "@tanstack/react-query";
import type { BrandContext } from "@decocms/shared/entities";
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
}

function useDefaultBrand(): BrandContext | null {
  const { org } = useProjectContext();
  const studio = useStudioTools();

  const { data } = useQuery<BrandContext | null>({
    queryKey: KEYS.defaultBrand(org.id),
    queryFn: async () => {
      const { items } = await studio.call("BRAND_CONTEXT_LIST", {});
      const brands = (Array.isArray(items) ? items : []) as BrandContext[];
      return brands.find((b) => b.isDefault && !b.archivedAt) ?? null;
    },
  });

  return data ?? null;
}

export function NoAiProviderEmptyState({
  title,
  description,
}: NoAiProviderEmptyStateProps = {}) {
  const t = useT();
  const { org } = useProjectContext();
  const brand = useDefaultBrand();
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
  const providers = aiProviders?.providers ?? [];

  const orgName = org.name;
  const brandIcon = brand?.favicon ?? brand?.logo ?? null;

  const heading =
    title ??
    (orgName
      ? t("chat.noAiProviderEmptyState.headingWithOrg", { org: orgName })
      : t("chat.noAiProviderEmptyState.headingDefault"));
  const subtitle =
    description ?? t("chat.noAiProviderEmptyState.subtitleDefault");

  return (
    <EmptyState
      className="w-full max-w-3xl py-0"
      icon={
        brandIcon ? (
          <img src={brandIcon} alt="" className="size-6 object-contain" />
        ) : offerDownload ? (
          <button
            type="button"
            onClick={() => setDownloadDialogOpen(true)}
            aria-label={t("downloadApp.openLabel")}
            className="focus-ring flex size-full items-center justify-center rounded-m transition-colors hover:bg-accent"
          >
            <Monitor01 />
          </button>
        ) : (
          <Monitor01 />
        )
      }
      title={heading}
      description={subtitle}
    >
      <div className="mt-(--space-xl) w-full text-start">
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
    </EmptyState>
  );
}
