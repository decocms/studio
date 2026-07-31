import { type ReactNode, useState } from "react";
import { Monitor01 } from "@untitledui/icons";
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { ConnectProviderDialog } from "@/views/settings/ai-providers/connect-provider-dialog";
import {
  ProviderGrid,
  type ProviderSelection,
} from "@/views/settings/ai-providers/provider-grid";
import { useProjectContext } from "@/sdk";
import { useAiProviders } from "@/hooks/collections/use-ai-providers";
import { useAuthConfig } from "@/providers/auth-config-provider";
import { useCurrentLink } from "@/hooks/use-current-link";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";
import { useQuery } from "@tanstack/react-query";
import type { BrandContext } from "@decocms/shared/entities";
import {
  DownloadAppDialog,
  isMacDesktopBrowser,
} from "@/components/download-app-dialog";
import { useIsDesktopApp } from "@/hooks/use-is-desktop-app";
import { ConnectDesktopDialog } from "./connect-desktop-dialog";
import { ClaudeCodeIcon, CodexIcon } from "./agent-icons";
import { useOptionalChatPrefs } from "./context";
import type { AgentOption } from "./pills/agent-options";
import { useT } from "@/i18n/use-t.ts";

interface NoAiProviderEmptyStateProps {
  title?: string;
  description?: string;
  /**
   * Called right after the user picks a local runtime (Claude Code / Codex).
   * The component has already persisted the pick; this lets the host advance
   * the UI — the Chat side-panel view uses it to open the agent's Overview, mirroring
   * "new chat with this agent". Omitted by the model-selector popover, where
   * picking a runtime should not navigate.
   */
  onLocalRuntimePicked?: (option: AgentOption) => void;
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
  onLocalRuntimePicked,
}: NoAiProviderEmptyStateProps = {}) {
  const t = useT();
  const { org } = useProjectContext();
  const { localMode } = useAuthConfig();
  const brand = useDefaultBrand();
  const link = useCurrentLink();
  // Optional: this empty state also renders inside the standalone model
  // selector (settings / automations), which mounts outside ChatContextProvider.
  // The local-runtime buttons only appear in the Chat side-panel view, where the
  // provider is present.
  const chatPrefs = useOptionalChatPrefs();
  const [pendingProvider, setPendingProvider] =
    useState<ProviderSelection | null>(null);
  const [gridOpen, setGridOpen] = useState(false);
  const [desktopDialogOpen, setDesktopDialogOpen] = useState(false);
  const [downloadDialogOpen, setDownloadDialogOpen] = useState(false);
  const isDesktopApp = useIsDesktopApp();
  // The acquisition path for macOS browser users is the desktop app itself,
  // not the `bunx decocms link` CLI — so while no desktop is linked, the
  // monitor button offers the download instead of the connect dialog. Once a
  // link is online (or inside the app, or off-mac) the connect/status dialog
  // remains the right destination.
  const offerDownload = isMacDesktopBrowser() && !isDesktopApp && !link.online;

  const aiProviders = useAiProviders();
  const providers = aiProviders?.providers ?? [];

  // Local coding agents detected on the linked desktop. When present, they are
  // a first-class way to start chatting *without* any cloud provider — picking
  // one selects that runtime for the chat and the composer takes over. This is
  // why the empty state isn't a hard block when a desktop link is online.
  const localOptions: Array<{
    option: AgentOption;
    label: string;
    icon: ReactNode;
  }> = [];
  if (link.online) {
    if (link.capabilities.includes("claude-code")) {
      localOptions.push({
        option: "claude-code-desktop",
        label: "Claude Code",
        icon: <ClaudeCodeIcon size={16} />,
      });
    }
    if (link.capabilities.includes("codex")) {
      localOptions.push({
        option: "codex-desktop",
        label: "Codex",
        icon: <CodexIcon size={16} />,
      });
    }
  }
  // Local runtime buttons write the pending agent option into chat prefs, so
  // they only make sense where a chat context exists (the Chat side-panel view). Outside
  // it (standalone model selector), fall back to the connect-a-provider grid.
  const hasLocalOptions = localOptions.length > 0 && chatPrefs !== null;

  const orgName = org.name;
  const primaryColor = brand ? extractPrimaryColor(brand) : null;
  const brandIcon = brand?.favicon ?? brand?.logo ?? null;

  const heading =
    title ??
    (orgName
      ? t("chat.noAiProviderEmptyState.headingWithOrg", { org: orgName })
      : t("chat.noAiProviderEmptyState.headingDefault"));
  const subtitle =
    description ??
    (hasLocalOptions
      ? t("chat.noAiProviderEmptyState.subtitleWithDesktop")
      : localMode
        ? t("chat.noAiProviderEmptyState.subtitleLocalMode")
        : t("chat.noAiProviderEmptyState.subtitleDefault"));

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
        ) : (
          <button
            type="button"
            onClick={() =>
              offerDownload
                ? setDownloadDialogOpen(true)
                : setDesktopDialogOpen(true)
            }
            aria-label={
              offerDownload
                ? t("downloadApp.openLabel")
                : link.online
                  ? t("chat.noAiProviderEmptyState.desktopLinkedLabel")
                  : t("chat.noAiProviderEmptyState.connectDesktopLabel")
            }
            className={cn(
              badgeClass,
              "cursor-pointer transition-colors hover:bg-accent",
            )}
            style={badgeStyle}
          >
            <span className="relative inline-flex items-center justify-center">
              <Monitor01
                size={24}
                style={primaryColor ? { color: primaryColor } : undefined}
                className={cn(!primaryColor && "text-muted-foreground")}
              />
              {link.online && (
                <span className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-success ring-2 ring-background animate-pulse" />
              )}
            </span>
          </button>
        )}
        <div className="space-y-2">
          <p className="text-xl font-semibold text-foreground tracking-tight">
            {heading}
          </p>
          <p className="text-sm text-muted-foreground max-w-md">{subtitle}</p>
        </div>
      </div>

      {hasLocalOptions && (
        <div className="flex flex-col items-center gap-3 w-full">
          <div className="flex flex-wrap items-center justify-center gap-2">
            {localOptions.map((o) => (
              <Button
                key={o.option}
                variant="default"
                className="gap-2"
                onClick={() => {
                  chatPrefs?.setPendingAgentOption(o.option);
                  onLocalRuntimePicked?.(o.option);
                }}
              >
                {o.icon}
                {t("chat.noAiProviderEmptyState.useLabel", { label: o.label })}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-3 w-full max-w-xs text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            {t("chat.noAiProviderEmptyState.orConnectProvider")}
            <span className="h-px flex-1 bg-border" />
          </div>
        </div>
      )}

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

      <ConnectDesktopDialog
        open={desktopDialogOpen}
        onOpenChange={setDesktopDialogOpen}
      />

      <DownloadAppDialog
        open={downloadDialogOpen}
        onOpenChange={setDownloadDialogOpen}
      />
    </div>
  );
}
