import { Suspense } from "react";
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@decocms/ui/components/sidebar.tsx";
import { Coins04, Lightning01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { useProjectContext } from "@/sdk";
import { useDecoCredits } from "@/hooks/use-deco-credits";
import { useEntitlements, usePlansEnabled } from "@/hooks/use-entitlements";
import { useT } from "@/i18n/use-t.ts";
import { cn } from "@decocms/ui/lib/utils.ts";

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
  if (balanceDollars <= 5) return "text-warning";
  return "text-foreground/70";
}

/**
 * The dollar chip this slot used to hold. Kept for deployments with plans OFF,
 * where there is no bar to show instead — the same split `CreditsBalance`
 * makes on the settings card.
 */
function CreditChip() {
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { hasDecoKey, balanceDollars } = useDecoCredits();
  if (!hasDecoKey) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={
            balanceDollars != null
              ? `Credits: $${balanceDollars.toFixed(2)}`
              : "Credits"
          }
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

/** Mirrors the plan card's bar, which is the same number from the same read. */
const BAR_COLORS = {
  ok: "bg-primary",
  warn: "bg-warning",
  exhausted: "bg-destructive",
} as const;

/**
 * The org's AI usage, as a percentage. A percent and nothing else — the wallet
 * is the only place a dollar amount belongs, and it is not here.
 */
function UsageChip() {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { data } = useEntitlements();
  // No answer and no envelope both mean there is no honest bar to draw.
  if (!data?.usage || !data.features.chat) return null;

  // Clamped and finite-checked before it reaches a width: `width: NaN%` is an
  // invalid declaration, the browser drops it, and a `block` span with no width
  // fills its parent — so a bad number painted a FULL bar, in the exhausted
  // colour if the state said so.
  const raw = Math.round(data.usage.percent * 100);
  if (!Number.isFinite(raw)) return null;
  const percent = Math.min(100, Math.max(0, raw));
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          tooltip={`${t("settings.planUsage.aiUsage")}: ${percent}%`}
          className="h-auto! py-1.5"
          onClick={() =>
            navigate({
              to: "/$org/settings/ai-providers",
              params: { org: org.slug },
            })
          }
        >
          <Lightning01 />
          <span className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate">
                {t("settings.planUsage.aiUsage")}
              </span>
              <span className="tabular-nums text-xs text-muted-foreground">
                {percent}%
              </span>
            </span>
            <span className="block h-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn("block h-full", BAR_COLORS[data.usage.state])}
                style={{ width: `${percent}%` }}
              />
            </span>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function TopChip() {
  return usePlansEnabled() ? <UsageChip /> : <CreditChip />;
}

export function SidebarTopActions() {
  return (
    <SilentErrorBoundary>
      <Suspense fallback={null}>
        <TopChip />
      </Suspense>
    </SilentErrorBoundary>
  );
}
