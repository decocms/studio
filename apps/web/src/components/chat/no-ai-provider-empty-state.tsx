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

function extractPrimaryColor(brand: BrandContext): string | null {
  const colors = brand.colors;
  if (!colors) return null;

  if (Array.isArray(colors)) {
    const entry = colors.find(
      (c) =>
        typeof c === "object" &&
        c !== null &&
        "label" in c &&
        /primary|brand|main/i.test((c as { label: string }).label),
    );
    const val = entry
      ? (entry as { value?: string }).value
      : (colors[0] as { value?: string })?.value;
    return typeof val === "string" ? val : null;
  }

  if (typeof colors === "object") {
    const rec = colors as Record<string, string>;
    return rec.primary ?? Object.values(rec)[0] ?? null;
  }

  return null;
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
  const primaryColor = brand ? extractPrimaryColor(brand) : null;
  const brandIcon = brand?.favicon ?? brand?.logo ?? null;

  const heading =
    title ??
    (orgName
      ? t("chat.noAiProviderEmptyState.headingWithOrg", { org: orgName })
      : t("chat.noAiProviderEmptyState.headingDefault"));
  const subtitle =
    description ?? t("chat.noAiProviderEmptyState.subtitleDefault");

  // Badge styles: use brand color if available, otherwise a neutral muted background
  const hasBrandStyle = !!(brandIcon || primaryColor);
  const badgeStyle = primaryColor
    ? {
        backgroundColor: `${primaryColor}18`,
        borderColor: `${primaryColor}30`,
      }
    : undefined;
  const badgeClass = hasBrandStyle
    ? "flex items-center justify-center size-14 rounded-2xl border"
    : "flex items-center justify-center size-14 rounded-2xl bg-muted border border-border";

  return (
    <div className="flex flex-col items-center gap-8 w-full max-w-3xl px-4">
      <div className="flex flex-col items-center gap-4 text-center">
        {brandIcon ? (
          <div className={badgeClass} style={badgeStyle}>
            <img
              src={brandIcon}
              alt=""
              className="size-7 rounded object-contain"
            />
          </div>
        ) : offerDownload ? (
          <button
            type="button"
            onClick={() => setDownloadDialogOpen(true)}
            aria-label={t("downloadApp.openLabel")}
            className={cn(
              badgeClass,
              "cursor-pointer transition-colors hover:bg-accent",
            )}
            style={badgeStyle}
          >
            <Monitor01
              size={24}
              style={primaryColor ? { color: primaryColor } : undefined}
              className={cn(!primaryColor && "text-muted-foreground")}
            />
          </button>
        ) : (
          <div className={badgeClass} style={badgeStyle}>
            <Monitor01
              size={24}
              style={primaryColor ? { color: primaryColor } : undefined}
              className={cn(!primaryColor && "text-muted-foreground")}
            />
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
