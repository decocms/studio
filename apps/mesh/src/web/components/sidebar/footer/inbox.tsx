import { authClient } from "@/web/lib/auth-client";
import { MeshUserMenu } from "@/web/components/user-menu";
import { useSettingsModal } from "@/web/hooks/use-settings-modal";
import { Button } from "@deco/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@deco/ui/components/popover.tsx";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Check, Coins01, Inbox01, XClose } from "@untitledui/icons";
import { AuthUIContext } from "@daveyplate/better-auth-ui";
import { cn } from "@deco/ui/lib/utils.ts";
import { Component, Suspense, useContext, useState } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useAiProviderKeyList } from "@/web/hooks/collections/use-llm";

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
        const setActiveResult = await authClient.organization.setActive({
          organizationId: invitation.organizationId,
        });
        toast.success("Invitation accepted!");
        const slug = setActiveResult?.data?.slug;
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
  const { open } = useSettingsModal();
  const { org } = useProjectContext();

  const client = useMCPClient({
    connectionId: SELF_MCP_ALIAS_ID,
    orgId: org.id,
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

  return (
    <button
      type="button"
      onClick={() => open("org.billing")}
      className="group-data-[collapsible=icon]:hidden flex items-center justify-between w-full px-2 py-1.5 rounded-md hover:bg-sidebar-accent transition-colors"
    >
      <div className="flex items-center gap-1.5">
        <Coins01 size={13} className="text-muted-foreground/60 shrink-0" />
        <span className="text-xs text-muted-foreground">Credits</span>
      </div>
      {isPending || isError || balanceDollars == null ? (
        <span className="text-xs font-medium tabular-nums text-muted-foreground/40">
          —
        </span>
      ) : (
        <span
          className={cn(
            "text-xs font-medium tabular-nums",
            creditColor(balanceDollars),
          )}
        >
          ${balanceDollars.toFixed(2)}
        </span>
      )}
    </button>
  );
}

function CreditChipConditional() {
  const keys = useAiProviderKeyList();
  const hasDecoKey = keys.some((k) => k.providerId === "deco");

  if (!hasDecoKey) return null;

  return <CreditChip />;
}

export function SidebarInboxFooter() {
  const pendingInvitations = usePendingInvitations();

  return (
    <SidebarFooter className="px-3.5 pb-3 group-data-[collapsible=icon]:px-2">
      <SilentErrorBoundary>
        <Suspense fallback={null}>
          <CreditChipConditional />
        </Suspense>
      </SilentErrorBoundary>
      <SidebarMenu>
        <SidebarMenuItem>
          <div className="flex items-center w-full gap-1">
            <div className="flex-1 min-w-0">
              <MeshUserMenu />
            </div>
            <div className="group-data-[collapsible=icon]:hidden">
              <Popover>
                <div className="relative">
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-8 text-sidebar-foreground/50 hover:text-sidebar-foreground hover:bg-sidebar-accent"
                      aria-label="Open inbox"
                    >
                      <Inbox01 size={16} />
                    </Button>
                  </PopoverTrigger>
                  {pendingInvitations.length > 0 && (
                    <span className="absolute top-1 right-1 size-2 rounded-full bg-red-500 ring-2 ring-sidebar pointer-events-none" />
                  )}
                </div>
                <PopoverContent
                  side="right"
                  align="end"
                  sideOffset={24}
                  className="w-[400px] p-0 h-[650px] flex flex-col"
                >
                  <div className="px-4 py-3 border-b border-border shrink-0">
                    <h3 className="text-sm font-medium">Inbox</h3>
                  </div>
                  {pendingInvitations.length === 0 ? (
                    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                      <Inbox01 size={24} className="text-muted-foreground/50" />
                      <p className="text-sm font-medium text-foreground">
                        No messages or invites pending
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Messages, workspace and project invitations will appear
                        here
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
            </div>
          </div>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarFooter>
  );
}
