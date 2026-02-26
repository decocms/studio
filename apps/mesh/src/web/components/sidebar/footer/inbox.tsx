import { authClient } from "@/web/lib/auth-client";
import { setCurrentOrgId } from "@/web/lib/org-store";
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
  useConnections,
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { isDecoAIGatewayUrl } from "@/core/deco-constants";

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

        // Keep the per-tab org store in sync with the explicit switch.
        if (setActiveResult?.data?.id) {
          setCurrentOrgId(setActiveResult.data.id);
        }

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

type LimitPeriod = "daily" | "weekly" | "monthly";

interface GatewayUsageResult {
  billing: { mode: "prepaid" | "postpaid"; limitPeriod: LimitPeriod | null };
  limit: { remaining: number | null; total: number | null };
  usage: { total: number; daily: number; weekly: number; monthly: number };
}

const CHIP_PERIOD_KEY = "gateway-chip-period";

function getChipPeriod(): LimitPeriod {
  try {
    const stored = localStorage.getItem(CHIP_PERIOD_KEY);
    if (stored === "daily" || stored === "weekly" || stored === "monthly")
      return stored;
  } catch {
    // ignore
  }
  return "daily";
}

function prepaidColor(remaining: number, total: number | null): string {
  if (!total || total <= 0) return "text-foreground/70";
  const pct = remaining / total;
  if (pct <= 0.05) return "text-destructive";
  if (pct <= 0.2) return "text-amber-500 dark:text-amber-400";
  return "text-foreground/70";
}

function postpaidUsedColor(percentUsed: number): string {
  if (percentUsed >= 90) return "text-destructive";
  if (percentUsed >= 70) return "text-amber-500 dark:text-amber-400";
  return "text-foreground/70";
}

function CreditChip({ connectionId }: { connectionId: string }) {
  const { open } = useSettingsModal();
  const { org } = useProjectContext();

  const client = useMCPClient({ connectionId, orgId: org.id });

  const { data } = useMCPToolCallQuery<GatewayUsageResult | undefined>({
    client,
    toolName: "GATEWAY_USAGE",
    toolArguments: {},
    staleTime: 60_000,
    select: (result) =>
      (result as { structuredContent?: GatewayUsageResult }).structuredContent,
  });

  const billingMode = data?.billing.mode ?? "prepaid";
  const limitTotal = data?.limit.total ?? null;
  const limitRemaining = data?.limit.remaining ?? 0;
  const usage = data?.usage ?? { total: 0, daily: 0, weekly: 0, monthly: 0 };

  let label: string;
  let value: string;
  let valueColor: string;

  if (billingMode === "prepaid") {
    label = "Credits";
    value = `$${limitRemaining.toFixed(2)}`;
    valueColor = prepaidColor(limitRemaining, limitTotal);
  } else if (limitTotal != null && limitTotal > 0) {
    const used = limitTotal - limitRemaining;
    const pct = Math.min(100, Math.round((used / limitTotal) * 100));
    label = "Usage";
    value = `${pct}%`;
    valueColor = postpaidUsedColor(pct);
  } else {
    const chipPeriod = getChipPeriod();
    const periodUsage =
      chipPeriod === "daily"
        ? usage.daily
        : chipPeriod === "weekly"
          ? usage.weekly
          : usage.monthly;
    const periodSuffix =
      chipPeriod === "daily" ? "/day" : chipPeriod === "weekly" ? "/wk" : "/mo";
    label = "Usage";
    value = `$${periodUsage.toFixed(2)}${periodSuffix}`;
    valueColor = "text-foreground/70";
  }

  return (
    <button
      type="button"
      onClick={() => open("org.billing")}
      className="group-data-[collapsible=icon]:hidden flex items-center justify-between w-full px-2 py-1.5 rounded-md hover:bg-sidebar-accent transition-colors"
    >
      <div className="flex items-center gap-1.5">
        <Coins01 size={13} className="text-muted-foreground/60 shrink-0" />
        <span className="text-xs text-muted-foreground">{label}</span>
      </div>
      <span className={cn("text-xs font-medium tabular-nums", valueColor)}>
        {value}
      </span>
    </button>
  );
}

function CreditChipConditional() {
  const connections = useConnections();

  const gatewayConnection = connections.find((c) =>
    isDecoAIGatewayUrl(c.connection_url),
  );

  if (!gatewayConnection?.id) {
    return null;
  }

  return <CreditChip connectionId={gatewayConnection.id} />;
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
