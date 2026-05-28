import { Suspense } from "react";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@deco/ui/components/sidebar.tsx";
import { Coins04 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import {
  SELF_MCP_ALIAS_ID,
  useMCPClient,
  useMCPToolCallQuery,
  useProjectContext,
} from "@decocms/mesh-sdk";
import { useAiProviderKeys } from "@/web/hooks/collections/use-ai-providers";
import { cn } from "@deco/ui/lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";

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

export function SidebarTopActions() {
  return (
    <SilentErrorBoundary>
      <Suspense fallback={null}>
        <CreditChipConditional />
      </Suspense>
    </SilentErrorBoundary>
  );
}

function CreditChipInline() {
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
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={tooltipLabel}
          onClick={() =>
            navigate({
              to: "/$org/settings/ai-providers",
              params: { org: org.slug },
            })
          }
          className={cn(
            "relative flex h-10 md:h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
            "hover:bg-sidebar-accent hover:text-sidebar-foreground",
            balanceDollars != null
              ? creditColor(balanceDollars)
              : "text-sidebar-foreground/60",
          )}
        >
          <Coins04 className="size-4" />
          {balanceDollars != null && (
            <span>{`$${balanceDollars.toFixed(2)}`}</span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltipLabel}</TooltipContent>
    </Tooltip>
  );
}

function CreditChipInlineConditional() {
  const keys = useAiProviderKeys();
  const hasDecoKey = keys.some((k) => k.providerId === "deco");
  if (!hasDecoKey) return null;
  return <CreditChipInline />;
}

export function SidebarTopActionsInline() {
  return (
    <SilentErrorBoundary>
      <Suspense fallback={null}>
        <CreditChipInlineConditional />
      </Suspense>
    </SilentErrorBoundary>
  );
}
