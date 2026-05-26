import { Suspense, useState } from "react";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Coins04, ZapSquare } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { AddConnectionDialog } from "@/web/views/virtual-mcp/add-connection-dialog";
import { track } from "@/web/lib/posthog-client";
import { cn } from "@deco/ui/lib/utils.ts";

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
  override componentDidCatch(_error: Error, _info: ErrorInfo): void {}
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
          <Coins04 />
          <span>
            {balanceDollars != null
              ? `$${balanceDollars.toFixed(2)}`
              : "Credits"}
          </span>
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
                source: "sidebar_top",
                mode: "browse",
              });
              setOpen(true);
            }}
          >
            <ZapSquare />
            <span>Connections</span>
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

export function SidebarTopActions() {
  return (
    <div className="flex flex-col gap-0.5">
      <ConnectionsButton />
      <SilentErrorBoundary>
        <Suspense fallback={null}>
          <CreditChipConditional />
        </Suspense>
      </SilentErrorBoundary>
    </div>
  );
}
