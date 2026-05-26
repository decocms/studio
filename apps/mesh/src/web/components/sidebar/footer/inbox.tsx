import { authClient } from "@/web/lib/auth-client";
import { AccountPopover } from "@/web/components/account-popover";
import { Button } from "@deco/ui/components/button.tsx";
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
import { Check, Inbox01, Settings02, XClose } from "@untitledui/icons";
import { AuthUIContext } from "@daveyplate/better-auth-ui";
import { useContext, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useProjectContext } from "@decocms/mesh-sdk";
import { useNavigate } from "@tanstack/react-router";

interface Invitation {
  id: string;
  organizationId: string;
  organizationName?: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
}

function InvitationItem({ invitation }: { invitation: Invitation }) {
  const [isAccepting, setIsAccepting] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const queryClient = useQueryClient();

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      const result = await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      });
      if (result.error) {
        toast.error(result.error.message);
        setIsAccepting(false);
      } else {
        // Fetch org slug for redirect without mutating the session's active
        // org (avoids cross-tab leak — see shell-layout.tsx).
        const orgResult = await authClient.organization.getFullOrganization({
          query: { organizationId: invitation.organizationId },
        });
        toast.success("Invitation accepted!");
        const slug = orgResult?.data?.slug;
        window.location.href = slug ? `/${slug}` : "/";
      }
    } catch {
      toast.error("Failed to accept invitation");
      setIsAccepting(false);
    }
  };

  const handleReject = async () => {
    setIsRejecting(true);
    try {
      const result = await authClient.organization.rejectInvitation({
        invitationId: invitation.id,
      });
      if (result.error) {
        toast.error(result.error.message);
        setIsRejecting(false);
      } else {
        toast.success("Invitation declined");
        queryClient.invalidateQueries();
      }
    } catch {
      toast.error("Failed to decline invitation");
      setIsRejecting(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-5 py-4 border-b border-border last:border-0 hover:bg-muted/25 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">
          You&apos;ve been invited to join
        </p>
        <p className="text-sm font-medium truncate">
          {invitation.organizationName ?? "Unknown organization"}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
          onClick={handleAccept}
          disabled={isAccepting || isRejecting}
          aria-label="Accept invitation"
        >
          <Check size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={handleReject}
          disabled={isAccepting || isRejecting}
          aria-label="Decline invitation"
        >
          <XClose size={14} />
        </Button>
      </div>
    </div>
  );
}

function usePendingInvitations() {
  const authUi = useContext(AuthUIContext);
  const { data } = authUi.hooks.useListUserInvitations();
  const invitations = (data ?? []) as Invitation[];
  return invitations.filter(
    (inv) => inv.status === "pending" && new Date(inv.expiresAt) > new Date(),
  );
}

function InboxButton() {
  const pendingInvitations = usePendingInvitations();

  return (
    <Popover>
      <SidebarMenu>
        <SidebarMenuItem>
          <PopoverTrigger asChild>
            <SidebarMenuButton tooltip="Inbox" className="relative">
              <Inbox01 size={24} />
              {pendingInvitations.length > 0 && (
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
        <div className="px-4 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-medium">Inbox</h3>
        </div>
        {pendingInvitations.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <Inbox01 size={24} className="text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">
              No invites pending
            </p>
            <p className="text-xs text-muted-foreground">
              Organization invitations will appear here
            </p>
          </div>
        ) : (
          <div className="overflow-y-auto flex-1">
            {pendingInvitations.map((inv) => (
              <InvitationItem key={inv.id} invitation={inv} />
            ))}
          </div>
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
