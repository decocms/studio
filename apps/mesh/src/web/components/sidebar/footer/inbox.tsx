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
import { Button } from "@deco/ui/components/button.tsx";
import {
  ArrowLeft,
  Inbox01,
  Settings02,
  UserPlus01,
  ZapSquare,
} from "@untitledui/icons";
import { useState, type ReactNode } from "react";
import { RepoSwitcher } from "@/web/components/sidebar/footer/repo-switcher";
import { InviteMemberDialog } from "@/web/components/invite-member-dialog";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
import { InvitationItem } from "@/web/components/sidebar/footer/invitation-item";
import { JoinRequestItem } from "@/web/components/sidebar/footer/join-request-item";
import { InboxReleaseItem } from "@/web/components/release-channel/inbox-release-item";
import { ReleaseCard } from "@/web/components/release-channel/release-card";
import { useInboxFeed } from "@/web/hooks/use-inbox-feed";
import { SidebarTopActions } from "@/web/components/sidebar/top-actions";

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
                  Invitations, join requests, and release updates will appear
                  here
                </p>
              </div>
            ) : (
              <div className="overflow-y-auto flex-1">
                {items.map((item) => {
                  if (item.type === "join-request") {
                    return (
                      <JoinRequestItem
                        key={`req-${item.request.id}`}
                        request={item.request}
                      />
                    );
                  }
                  if (item.type === "invitation") {
                    return (
                      <InvitationItem
                        key={`inv-${item.invitation.id}`}
                        invitation={item.invitation}
                      />
                    );
                  }
                  return (
                    <InboxReleaseItem
                      key={`rel-${item.release.id}`}
                      release={item.release}
                      isSeen={item.isSeen}
                      onSelect={() => handleSelectRelease(item.release.id)}
                    />
                  );
                })}
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
          {hasUnread && (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-red-500 pointer-events-none" />
          )}
          <span>Inbox</span>
        </SidebarMenuButton>
      </PopoverTrigger>
    </InboxPopover>
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

/**
 * Sidebar footer actions — org-wide entry points that aren't tied to a single
 * agent: invite teammates, add a repo as an org-shared GitHub connection
 * (available to every agent), and add any connection. Rendered as full-width
 * rows above the account row.
 */
function SidebarExtraActions() {
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  return (
    <>
      <SidebarMenu className="gap-0.5">
        <SidebarMenuItem>
          <InviteMemberDialog
            trigger={
              <SidebarMenuButton tooltip="Invite members">
                <UserPlus01 />
                <span>Invite members</span>
              </SidebarMenuButton>
            }
          />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <RepoSwitcher />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip="Add connection"
            onClick={() => setConnectionsOpen(true)}
          >
            <ZapSquare />
            <span>Add connection</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
      <AddConnectionDialog
        open={connectionsOpen}
        onOpenChange={setConnectionsOpen}
        mode="browse"
      />
    </>
  );
}

export function SidebarInboxFooter() {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  if (isCollapsed) {
    return (
      <SidebarFooter className="px-2 pb-3 gap-1">
        <SidebarExtraActions />
        <SidebarTopActions />
        <SidebarMenu>
          <SidebarMenuItem>
            <InboxFullButton />
          </SidebarMenuItem>
          <SidebarMenuItem>
            <div className="flex justify-center">
              <LinkedDesktopIndicator />
            </div>
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
    <SidebarFooter className="px-2 pb-3 gap-0.5">
      <SidebarExtraActions />
      <SidebarTopActions />
      <SidebarMenu className="gap-0.5">
        <SidebarMenuItem>
          <InboxFullButton />
        </SidebarMenuItem>
        <SidebarMenuItem>
          <LinkedDesktopIndicator variant="full" />
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
