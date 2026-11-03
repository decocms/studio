import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight, Plus } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@decocms/ui/components/popover.tsx";
import { Progress } from "@decocms/ui/components/progress.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { QuickTopUp } from "./deco-credits-hero";
import { usePreferences } from "@/hooks/use-preferences.ts";
import {
  useEntitlements,
  useFeature,
  usePlansEnabled,
} from "@/hooks/use-entitlements";
import { useOpenBillingUrl } from "@/hooks/use-open-billing-url";
import { useCapability } from "@/hooks/use-capability";
import { PlanPlant, usePlanCatalog } from "./plan-ladder";

// The org's plan: allowance as a percent only (pricing decision), credits in dollars.

/** `spent` is a full allowance with credits behind it: done, not a problem. */
const NUMERAL_STYLES = {
  ok: "text-foreground",
  warn: "text-warning",
  exhausted: "text-destructive",
  spent: "text-muted-foreground",
} as const;

const BAR_STYLES = {
  ok: "[&>[data-slot=progress-indicator]]:bg-brand-purple",
  warn: "[&>[data-slot=progress-indicator]]:bg-warning",
  exhausted: "[&>[data-slot=progress-indicator]]:bg-destructive",
  spent: "[&>[data-slot=progress-indicator]]:bg-muted-foreground/40",
} as const;

/** One pool: its label, its number, its bar, and what sits under the bar. */
function Pool({
  label,
  badge,
  value,
  unit,
  valueClassName,
  bar,
  footer,
}: {
  label: string;
  badge?: ReactNode;
  value: string;
  unit?: string;
  valueClassName: string;
  bar?: ReactNode;
  footer: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex h-5 items-center gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        {badge}
      </div>
      <div className="flex items-baseline gap-2">
        <span
          className={cn(
            "text-4xl font-semibold leading-none tracking-tight tabular-nums",
            valueClassName,
          )}
        >
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      <div className="flex flex-col gap-2">
        {bar}
        {footer}
      </div>
    </div>
  );
}

function AddCreditsButton() {
  const t = useT();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="w-fit">
          <Plus size={14} />
          {t("settings.decoCreditsHero.addCredits")}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto">
        <QuickTopUp />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The Stripe portal is the ONLY way out of a paid plan — `AI_PLAN_SET` refuses
 * to drop an org while a subscription is bound, precisely so the card is not
 * charged for features the gateway has already taken away. So an org that has
 * a subscription needs a door to that portal on this page: the catalog below
 * offers no way out of a plan.
 */
function ManageBillingButton() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { data } = useQuery({
    queryKey: KEYS.orgBillingAccount(org.id),
    staleTime: 60_000,
    queryFn: () => studio.call("ORGANIZATION_BILLING_GET", {}),
  });
  const { mutate: openPortal, isPending } = useOpenBillingUrl(
    "ORGANIZATION_BILLING_PORTAL",
    "settings.planUsage.portalFailed",
  );
  if (!data?.hasBillingAccount) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={isPending}
      onClick={() => openPortal()}
    >
      {t("settings.planUsage.manageBilling")}
    </Button>
  );
}

/**
 * Monitor is where the org sees what spent the allowance. Not gated on the
 * `monitoring` plan feature: that sells site analytics, and the org's
 * tool-call Monitor is on every plan, gated only by role.
 */
export function AiUsageButton() {
  const t = useT();
  const { org } = useProjectContext();
  const plansEnabled = usePlansEnabled();
  const { granted } = useCapability("monitoring:view");

  if (!plansEnabled || !granted) return null;
  return (
    <Button variant="outline" size="sm" asChild>
      <Link
        to="/$org/settings/monitor"
        params={{ org: org.slug }}
        search={{ tab: "overview" }}
      >
        {t("settings.planUsage.aiUsage")}
        <ChevronRight size={14} />
      </Link>
    </Button>
  );
}

export function PlanUsageCard() {
  const t = useT();
  const [preferences] = usePreferences();

  const plansEnabled = usePlansEnabled();
  // Whether the credits pool belongs on this card at all. Every plan carries
  // `credits` today, so this is the no-plan and per-org revoke case.
  const canBuyCredits = useFeature("credits");
  const { data, isLoading, isError, refetch } = useEntitlements();
  const { data: plans } = usePlanCatalog();
  const planIndex = plans?.findIndex((p) => p.id === data?.plan.id) ?? -1;

  // The "no plan surface here" case the error branch below excuses itself for:
  // the deployment has plans switched off, so there is nothing to show and
  // nothing failed. Not a hook, so it has to sit after the hooks above.
  if (!plansEnabled) return null;

  if (isLoading) {
    return (
      <SettingsSection title={t("settings.planUsage.title")}>
        <SettingsCard>
          <div className="px-5 py-5">
            <Skeleton className="h-24 w-full" />
          </div>
        </SettingsCard>
      </SettingsSection>
    );
  }

  // A card that vanishes on failure is worse than one that says it failed: an
  // org (or a developer) has no way to tell "no plan surface here" from "the
  // read broke". Only a deployment with no gateway at all renders nothing.
  if (isError || !data) {
    return (
      <SettingsSection title={t("settings.planUsage.title")}>
        <SettingsCard>
          <div className="px-5 py-5 flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {t("settings.planUsage.loadFailed")}
            </p>
            <Button variant="outline" size="sm" onClick={() => refetch()}>
              {t("settings.planUsage.retry")}
            </Button>
          </div>
        </SettingsCard>
      </SettingsSection>
    );
  }

  // Clamped and finite-checked: the wire is 0..1 but a NaN or a negative
  // arriving here produced `translateX(-NaN%)`, an invalid declaration the
  // browser drops — which renders the indicator FULL and untranslated, i.e. a
  // bad number reads as "you have used everything".
  const rawPercent = data.usage ? Math.round(data.usage.percent * 100) : null;
  const percent =
    rawPercent !== null && Number.isFinite(rawPercent)
      ? Math.min(100, Math.max(0, rawPercent))
      : null;
  const state = data.usage?.state ?? "ok";
  // `free` is the absence of a plan: nothing to measure and nothing renews.
  const noPlan = data.plan.id === "free";
  // A plan with no chat has no AI envelope at all, so a full red bar would
  // read as "you burned through it" on an org that never had any.
  const hasAiEnvelope = !noPlan && data.features.chat;
  const creditsUsd = data.credits?.remainingUsd ?? null;
  /** A gateway date as "16 Aug", or null for anything we can't honestly date. */
  const shortDate = (iso: string | null): string | null => {
    if (!iso) return null;
    const at = new Date(iso);
    if (Number.isNaN(at.getTime())) return null;
    return at.toLocaleDateString(preferences.language, {
      day: "numeric",
      month: "short",
    });
  };
  const periodStartLabel = shortDate(data.periodStart);
  const periodEndLabel = shortDate(data.periodEnd);
  /** Both endpoints or neither — a lone date under a bar reads as a deadline. */
  const periodRange =
    periodStartLabel && periodEndLabel
      ? { start: periodStartLabel, end: periodEndLabel }
      : null;

  // Credits are spent after the allowance, so a full bar with a balance is not a wall.
  const onCredits =
    state === "exhausted" && creditsUsd !== null && creditsUsd > 0;
  const allowanceState = onCredits ? "spent" : state;

  return (
    <Card className="p-6 gap-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {/* The same rung the catalog below draws for this tier, so the
              card and its card agree. Absent until the ladder resolves —
              the wrong plant then the right one is worse than none. */}
          {planIndex >= 0 && <PlanPlant index={planIndex} className="size-6" />}
          <span className="text-sm font-medium">
            {noPlan ? t("settings.planUsage.noPlan") : data.plan.name}
          </span>
        </div>
        <ManageBillingButton />
      </div>

      {/* Credits sit beside the bar, not in it: a bar at 100% read as "out of AI" to orgs holding credits. */}
      <div
        className={cn(
          "grid gap-x-8 gap-y-6",
          canBuyCredits && "sm:grid-cols-[minmax(0,1fr)_minmax(0,15rem)]",
        )}
      >
        {hasAiEnvelope ? (
          <Pool
            label={t("settings.planUsage.included")}
            value={
              percent === null
                ? t("settings.planUsage.usageUnavailable")
                : `${percent}%`
            }
            unit={percent !== null ? t("settings.planUsage.used") : undefined}
            valueClassName={NUMERAL_STYLES[allowanceState]}
            bar={
              // Unknown consumption gets no fill: an empty bar would say "nothing used".
              percent === null ? (
                <div
                  className="h-3 w-full rounded-full bg-muted/60"
                  aria-hidden="true"
                />
              ) : (
                <Progress
                  value={percent}
                  aria-label={t("settings.planUsage.included")}
                  className={cn(
                    // Shows at the fill's leading edge; the trailing one is translated off-track.
                    "h-3 bg-muted [&>[data-slot=progress-indicator]]:rounded-full",
                    BAR_STYLES[allowanceState],
                  )}
                />
              )
            }
            footer={
              // The period the bar measures.
              periodRange ? (
                <div className="flex items-baseline justify-between gap-4 text-meta">
                  <span>{periodRange.start}</span>
                  <span>{periodRange.end}</span>
                </div>
              ) : (
                <span className="text-meta">
                  {t("settings.planUsage.periodHint")}
                </span>
              )
            }
          />
        ) : (
          <p className="text-sm text-muted-foreground self-center">
            {noPlan
              ? t("settings.planUsage.noPlanDescription")
              : t("settings.planUsage.noAiIncluded")}
          </p>
        )}

        {/* The org's own money, so shown in dollars. */}
        {canBuyCredits && (
          <Pool
            label={t("settings.planUsage.credits")}
            badge={
              onCredits ? (
                <Badge variant="success" size="sm">
                  {t("settings.planUsage.creditsInUse")}
                </Badge>
              ) : null
            }
            value={
              creditsUsd === null
                ? "—"
                : creditsUsd.toLocaleString(preferences.language, {
                    style: "currency",
                    currency: "USD",
                  })
            }
            valueClassName={
              creditsUsd !== null && creditsUsd > 0
                ? "text-foreground"
                : "text-muted-foreground"
            }
            footer={<AddCreditsButton />}
          />
        )}
      </div>
    </Card>
  );
}
