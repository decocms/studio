import { AccountPopover } from "@/web/components/account-popover";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import {
  ArrowLeft,
  Coins04,
  Inbox01,
  Settings02,
  ZapSquare,
} from "@untitledui/icons";
import { cn } from "@deco/ui/lib/utils.ts";
import { Component, Suspense, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { useNavigate } from "@tanstack/react-router";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { track } from "@/web/lib/posthog-client";
import { InvitationItem } from "@/web/components/sidebar/footer/invitation-item";
import { InboxReleaseItem } from "@/web/components/release-channel/inbox-release-item";
import { ReleaseCard } from "@/web/components/release-channel/release-card";
import { useInboxFeed } from "@/web/hooks/use-inbox-feed";
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";
import { Button } from "@deco/ui/components/button.tsx";

class SilentErrorBoundary extends Component<
  { children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Silently catch errors in the credit chip
  }

  override render(): ReactNode {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function creditColor(balanceDollars: number): string {
  if (balanceDollars <= 1) return "text-destructive";
  if (balanceDollars <= 5) return "text-amber-500 dark:text-amber-400";
  return "text-foreground/70";
}

function CreditChip() {
  const navigate = useNavigate();
  const { org } = useProjectContext();

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
    orgSlug: org.slug,
  });

  const { data, isPending, isError } = useMCPToolCallQuery<
    { balanceCents: number } | undefined
  >({
    client,
    toolName: "AI_PROVIDER_CREDITS",
    toolArguments: { providerId: "deco" },
    staleTime: 60_000,
    select: (result) =>
      (result as { structuredContent?: { balanceCents: number } })
        .structuredContent,
  });

  const balanceDollars =
    data?.balanceCents != null ? data.balanceCents / 100 : null;

  const tooltipLabel =
    isPending || isError || balanceDollars == null
      ? "Credits"
      : `Credits: $${balanceDollars.toFixed(2)}`;

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={tooltipLabel}
          className={cn(balanceDollars != null && creditColor(balanceDollars))}
          onClick={() =>
            navigate({
              to: "/$org/settings/ai-providers",
              params: { org: org.slug },
            })
          }
        >
          <Coins04 size={24} />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function CreditChipConditional() {
  const keys = useAiProviderKeys();
  const hasDecoKey = keys.some((k) => k.providerId === "deco");

  if (!hasDecoKey) return null;

  return <CreditChip />;
}

function ConnectionsButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="Connections"
            onClick={() => {
              track("connections_dialog_opened", {
                source: "sidebar_footer",
                mode: "browse",
              });
              setOpen(true);
            }}
          >
            <ZapSquare size={24} />
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <AddConnectionDialog
        mode="browse"
        open={open}
        onOpenChange={setOpen}
        defaultTab="all"
      />
    </>
  );
}

function InboxButton() {
  const { items, redDotCount } = useInboxFeed();
  const { markSeen } = useReleaseSeenState();
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(
    null,
  );

  const selectedRelease = items.find(
    (item) => item.type === "release" && item.release.id === selectedReleaseId,
  );
  const selectedReleaseData =
    selectedRelease?.type === "release" ? selectedRelease.release : null;

  const handleSelectRelease = (releaseId: string) => {
    markSeen(releaseId);
    setSelectedReleaseId(releaseId);
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setSelectedReleaseId(null);
      }}
    >
      <SidebarMenu>
        <SidebarMenuItem>
          <PopoverTrigger asChild>
            <SidebarMenuButton tooltip="Inbox" className="relative">
              <Inbox01 size={24} />
              {redDotCount > 0 && (
                <span className="absolute top-1 right-1 size-2 rounded-full bg-red-500 pointer-events-none" />
              )}
            </SidebarMenuButton>
          </PopoverTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={16}
        collisionPadding={16}
        className="w-[min(400px,calc(100vw-2rem))] p-0 h-[min(650px,calc(100dvh-4rem))] flex flex-col"
      >
        {selectedReleaseData ? (
          <>
            <div className="flex items-center gap-2 px-3 py-3 border-b border-border shrink-0">
              <Button
                size="icon"
                variant="ghost"
                aria-label="Back to inbox"
                className="size-7 text-muted-foreground"
                onClick={() => setSelectedReleaseId(null)}
              >
                <ArrowLeft size={16} />
              </Button>
              <h3 className="text-sm font-medium truncate">
                {selectedReleaseData.title}
              </h3>
            </div>
            <div className="overflow-y-auto flex-1 p-5">
              <ReleaseCard release={selectedReleaseData} />
            </div>
          </>
        ) : (
          <>
            <div className="px-4 py-3 border-b border-border shrink-0">
              <h3 className="text-sm font-medium">Inbox</h3>
            </div>
            {items.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <Inbox01 size={24} className="text-muted-foreground/50" />
                <p className="text-sm font-medium text-foreground">
                  Nothing here yet
                </p>
                <p className="text-xs text-muted-foreground">
                  Invitations and release updates will appear here
                </p>
              </div>
            ) : (
              <div className="overflow-y-auto flex-1">
                {items.map((item) =>
                  item.type === "invitation" ? (
                    <InvitationItem
                      key={`inv-${item.invitation.id}`}
                      invitation={item.invitation}
                    />
                  ) : (
                    <InboxReleaseItem
                      key={`rel-${item.release.id}`}
                      release={item.release}
                      isSeen={item.isSeen}
                      onSelect={() => handleSelectRelease(item.release.id)}
                    />
                  ),
                )}
              </div>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

function SettingsButton() {
  const navigate = useNavigate();
  const { org } = useProjectContext();

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip="Settings"
          onClick={() =>
            navigate({
              to: "/$org/settings",
              params: { org: org.slug },
            })
          }
        >
          <Settings02 size={24} />
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

export function SidebarInboxFooter() {
  return (
    <SidebarFooter className="px-2 pb-3 gap-1">
      <SilentErrorBoundary>
        <Suspense fallback={null}>
          <CreditChipConditional />
        </Suspense>
      </SilentErrorBoundary>
      <ConnectionsButton />
      <InboxButton />
      <SettingsButton />
      <SidebarMenu>
        <SidebarMenuItem>
          <AccountPopover />
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
