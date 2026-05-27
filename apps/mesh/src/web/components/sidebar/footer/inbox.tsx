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
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { Button } from "@deco/ui/components/button.tsx";
import { ArrowLeft, Inbox01, Settings02, ZapSquare } from "@untitledui/icons";
import { useState, type ReactNode } from "react";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { track } from "@/web/lib/posthog-client";
import { InvitationItem } from "@/web/components/sidebar/footer/invitation-item";
import { InboxReleaseItem } from "@/web/components/release-channel/inbox-release-item";
import { ReleaseCard } from "@/web/components/release-channel/release-card";
import { useInboxFeed } from "@/web/hooks/use-inbox-feed";

function InboxPopover({ children }: { children: ReactNode }) {
  const { items, markReleaseSeen } = useInboxFeed();
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(
    null,
  );

  const selectedRelease = items.find(
    (item) => item.type === "release" && item.release.id === selectedReleaseId,
  );
  const selectedReleaseData =
    selectedRelease?.type === "release" ? selectedRelease.release : null;

  const handleSelectRelease = (releaseId: string) => {
    setSelectedReleaseId(releaseId);
    markReleaseSeen(releaseId);
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setSelectedReleaseId(null);
      }}
    >
      {children}
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

function useHasUnreadInbox() {
  const { redDotCount } = useInboxFeed();
  return redDotCount > 0;
}

function InboxFullButton() {
  const hasUnread = useHasUnreadInbox();
  return (
    <InboxPopover>
      <PopoverTrigger asChild>
        <SidebarMenuButton tooltip="Inbox" className="relative">
          <Inbox01 />
          <span>Inbox</span>
          {hasUnread && (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-red-500 pointer-events-none" />
          )}
        </SidebarMenuButton>
      </PopoverTrigger>
    </InboxPopover>
  );
}

function InboxIconButton() {
  const hasUnread = useHasUnreadInbox();
  return (
    <InboxPopover>
      <Tooltip delayDuration={300}>
        <PopoverTrigger asChild>
          <TooltipTrigger asChild>
            <ToolbarIconButton aria-label="Inbox">
              <Inbox01 className="size-4" />
              {hasUnread && (
                <span className="absolute top-0.5 right-0.5 size-2 rounded-full bg-red-500 pointer-events-none" />
              )}
            </ToolbarIconButton>
          </TooltipTrigger>
        </PopoverTrigger>
        <TooltipContent side="top">Inbox</TooltipContent>
      </Tooltip>
    </InboxPopover>
  );
}

function ConnectionsFullButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
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
        <ZapSquare />
        <span>Connections</span>
      </SidebarMenuButton>
      <AddConnectionDialog
        mode="browse"
        open={open}
        onOpenChange={setOpen}
        defaultTab="all"
      />
    </>
  );
}

function ConnectionsIconButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <ToolbarIconButton
            aria-label="Connections"
            onClick={() => {
              track("connections_dialog_opened", {
                source: "sidebar_footer",
                mode: "browse",
              });
              setOpen(true);
            }}
          >
            <ZapSquare className="size-4" />
          </ToolbarIconButton>
        </TooltipTrigger>
        <TooltipContent side="top">Connections</TooltipContent>
      </Tooltip>
      <AddConnectionDialog
        mode="browse"
        open={open}
        onOpenChange={setOpen}
        defaultTab="all"
      />
    </>
  );
}

function SettingsFullButton() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return (
    <SidebarMenuButton
      tooltip="Settings"
      onClick={() =>
        navigate({
          to: "/$org/settings",
          params: { org: org.slug },
        })
      }
    >
      <Settings02 />
      <span>Settings</span>
    </SidebarMenuButton>
  );
}

function SettingsIconButton() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <ToolbarIconButton
          aria-label="Settings"
          onClick={() =>
            navigate({
              to: "/$org/settings",
              params: { org: org.slug },
            })
          }
        >
          <Settings02 className="size-4" />
        </ToolbarIconButton>
      </TooltipTrigger>
      <TooltipContent side="top">Settings</TooltipContent>
    </Tooltip>
  );
}

export function SidebarInboxFooter() {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  if (isCollapsed) {
    return (
      <SidebarFooter className="px-2 pb-3 gap-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <ConnectionsFullButton />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <InboxFullButton />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SettingsFullButton />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <AccountPopover />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    );
  }

  return (
    <SidebarFooter className="px-2 pb-3">
      <div className="flex items-center gap-1">
        <div className="flex-1 min-w-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <AccountPopover />
            </SidebarMenuItem>
          </SidebarMenu>
        </div>
        <SettingsIconButton />
        <InboxIconButton />
        <ConnectionsIconButton />
      </div>
    </SidebarFooter>
  );
}
