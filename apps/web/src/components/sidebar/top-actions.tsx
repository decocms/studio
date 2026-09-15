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
import { useSidebarCollapsed } from "@/hooks/use-sidebar-collapsed";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  SidebarFooterIcon,
  SIDEBAR_FOOTER_ICON_SIZE,
} from "@/components/sidebar/footer/icon-slot";
import {
  PlanPlant,
  usePlanCatalog,
} from "@/views/settings/ai-providers/plan-ladder";

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

/** The donut's arc, on the rail. Same three states as the bar below. */
const RING_COLORS = {
  ok: "stroke-brand-purple",
  warn: "stroke-warning",
  exhausted: "stroke-destructive",
} as const;

/** Mirrors the plan card's bar, which is the same number from the same read. */
const BAR_COLORS = {
  ok: "bg-brand-purple",
  warn: "bg-warning",
  exhausted: "bg-destructive",
} as const;

/**
 * The org's AI usage, as a percentage. A percent and nothing else — the wallet
 * is the only place a dollar amount belongs, and it is not here.
 */
function UsageChip() {
  const t = useT();
  const isCollapsed = useSidebarCollapsed();
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
        {/* A card rather than a menu row: it is a readout, not a destination
            that happens to have a bar. Still a button — it opens billing. */}
        <SidebarMenuButton
          tooltip={`${data.plan.name} · ${t("settings.planUsage.aiUsage")} ${percent}%`}
          className="h-auto! rounded-lg border border-border bg-card px-2 py-2 [&_svg]:opacity-100!"
          onClick={() =>
            navigate({
              to: "/$org/settings/ai-providers",
              params: { org: org.slug },
            })
          }
        >
          <SidebarFooterIcon className={cn(!isCollapsed && "-ml-px")}>
            {isCollapsed ? (
              <UsageDonut percent={percent} state={data.usage.state} />
            ) : (
              <PlanIcon planId={data.plan.id} />
            )}
          </SidebarFooterIcon>
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate font-medium">{data.plan.name}</span>
              <span className="tabular-nums text-xs text-muted-foreground">
                {percent}%
              </span>
            </span>
            <span className="block h-1 overflow-hidden rounded-full bg-muted">
              <span
                className={cn(
                  "block h-full rounded-full",
                  BAR_COLORS[data.usage.state],
                )}
                style={{ width: `${percent}%` }}
              />
            </span>
          </span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

/** The tier's plant, or nothing until the ladder resolves — the wrong rung is
 *  worse than a beat with no glyph. */
function PlanIcon({ planId }: { planId: string }) {
  const { data: plans } = usePlanCatalog();
  const index = plans?.findIndex((p) => p.id === planId) ?? -1;
  if (index < 0) return <Lightning01 className={SIDEBAR_FOOTER_ICON_SIZE} />;
  return <PlanPlant index={index} className={SIDEBAR_FOOTER_ICON_SIZE} />;
}

/**
 * The bar, as a ring — what the rail has room for.
 *
 * A collapsed sidebar drops the label and the bar, so the plant alone said
 * which tier the org was on and nothing about what it had spent. The ring is
 * the same number the bar draws, in the same three colours.
 */
function UsageDonut({
  percent,
  state,
}: {
  percent: number;
  state: keyof typeof RING_COLORS;
}) {
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg
      viewBox="0 0 20 20"
      className={cn("-rotate-90", SIDEBAR_FOOTER_ICON_SIZE)}
      aria-hidden="true"
    >
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="3"
        className="stroke-muted"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        className={RING_COLORS[state]}
        strokeDasharray={`${(circumference * percent) / 100} ${circumference}`}
      />
    </svg>
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
