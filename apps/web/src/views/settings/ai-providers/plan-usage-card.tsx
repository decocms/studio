import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
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

/**
 * The org's plan and its AI usage bar.
 *
 * The bar is a PERCENT and nothing else — no dollars, no tokens (that is the
 * pricing decision, not a shortcut): the only place money appears is a wallet
 * top-up. `usage: null` means the gateway could not read consumption, which
 * must read as unknown; an empty bar would tell the org it has spent nothing.
 *
 * Changing plan is not this card's job any more: the catalog renders inline
 * below it (`plan-catalog.tsx`), so the card is the org's current state and
 * nothing else.
 */

const NUMERAL_STYLES = {
  ok: "text-foreground",
  warn: "text-warning",
  exhausted: "text-destructive",
} as const;

const BAR_STYLES = {
  ok: "[&>[data-slot=progress-indicator]]:bg-brand-purple",
  warn: "[&>[data-slot=progress-indicator]]:bg-warning",
  exhausted: "[&>[data-slot=progress-indicator]]:bg-destructive",
} as const;

/**
 * The Stripe portal is the ONLY way out of a paid plan — `AI_PLAN_SET` refuses
 * to drop an org while a subscription is bound, precisely so the card is not
 * charged for features the gateway has already taken away. So an org that has
 * a subscription needs a door to that portal on this page, or the refusal it
 * gets from the Free card below is a dead end.
 */
function ManageBillingButton() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const { data } = useQuery({
    queryKey: KEYS.orgBillingAccount(org.id),
    staleTime: 60_000,
    queryFn: () => studio.call("ORGANIZATION_TASK_QUOTA_GET", {}),
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
 * The bar's own label, and the door to the detail behind it.
 *
 * A percentage is a summary; Monitor is where the org sees what spent it. The
 * label is the honest anchor for that link — the plan name in the header is a
 * plan, not a usage report. Falls back to plain text rather than a dead link
 * when the member has no `monitoring:view` (also the loading and the error
 * answer, so a blip renders a label rather than a door to a 403).
 *
 * Deliberately NOT gated on the `monitoring` PLAN feature: that one sells the
 * project's site analytics, and this link goes to the org's tool-call Monitor,
 * which every plan has and only the role gates. Two different rooms that the
 * navigation happens to call the same thing.
 */
function AiUsageLabel() {
  const t = useT();
  const { org } = useProjectContext();
  const { granted } = useCapability("monitoring:view");
  const label = t("settings.planUsage.aiUsage");

  if (!granted) {
    return <span className="text-sm text-muted-foreground">{label}</span>;
  }
  return (
    <Link
      to="/$org/settings/monitor"
      params={{ org: org.slug }}
      search={{ tab: "overview" }}
      className="flex items-center gap-0.5 text-sm text-muted-foreground hover:text-foreground"
    >
      {label}
      <ChevronRight size={14} />
    </Link>
  );
}

export function PlanUsageCard() {
  const t = useT();
  const [preferences] = usePreferences();

  const plansEnabled = usePlansEnabled();
  // Whether a credits row belongs on this card at all. Every plan carries
  // `credits` today, Free included — a spent trial is bought past as well as
  // upgraded past — so this is the per-org revoke case.
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
  // A plan with no chat has no AI envelope at all, so a full red bar would
  // read as "you burned through it" on an org that never had any.
  const hasAiEnvelope = data.features.chat;
  // Dollars, localized. Read only inside the exhausted branch below, so an org
  // that never fills its bar never sees an amount anywhere in the product.
  const creditsUsd = data.credits?.remainingUsd ?? null;
  // The gateway sends a period_end for free too, and free never refills.
  const renews = data.plan.id !== "free";
  /** A gateway date as "16 Aug", or null for anything we can't honestly date. */
  const shortDate = (iso: string | null): string | null => {
    if (!renews || !iso) return null;
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

  // What the endpoints can't say: an undated plan, and Free's fixed ceiling.
  const hint = renews
    ? t("settings.planUsage.periodHint")
    : t("settings.planUsage.oneTimeHint");

  return (
    <Card className="p-0 gap-0 overflow-hidden">
      <div className="px-6 py-6 flex flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {/* The same rung the catalog below draws for this tier, so the
                card and its card agree. Absent until the ladder resolves —
                the wrong plant then the right one is worse than none. */}
            {planIndex >= 0 && (
              <PlanPlant index={planIndex} className="size-6" />
            )}
            <span className="text-sm font-medium">{data.plan.name}</span>
          </div>
          <div className="flex items-center gap-3">
            {hasAiEnvelope && <AiUsageLabel />}
            <ManageBillingButton />
          </div>
        </div>

        {hasAiEnvelope ? (
          <div className="flex flex-col gap-4">
            {/* The number IS the card. Coloured by state so a full bar reads as
                full from across the room; a badge saying so as well was a second
                voice. */}
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "text-4xl font-semibold leading-none tracking-tight tabular-nums",
                  NUMERAL_STYLES[state],
                )}
              >
                {percent === null
                  ? t("settings.planUsage.usageUnavailable")
                  : `${percent}%`}
              </span>
              {/* Only against a real number — "Unavailable used" is not a
                  sentence. */}
              {percent !== null && (
                <span className="text-sm text-muted-foreground">
                  {t("settings.planUsage.used")}
                </span>
              )}
            </div>
            {/* No bar at all when consumption is UNKNOWN. `value={percent ??
                0}` rendered a full-width EMPTY track, which is the one
                reading this card's own docstring forbids: an empty bar says
                "nothing used", and the honest answer is "we could not read
                it". The label above already says Unavailable; this is a
                placeholder track with no fill, not a measurement. */}
            <div className="flex flex-col gap-2">
              {percent === null ? (
                <div
                  className="h-3 w-full rounded-full bg-muted/60"
                  aria-hidden="true"
                />
              ) : (
                <Progress
                  value={percent}
                  className={cn(
                    // Shows at the fill's leading edge; the trailing one is translated off-track.
                    "h-3 bg-muted [&>[data-slot=progress-indicator]]:rounded-full",
                    BAR_STYLES[state],
                  )}
                />
              )}
              {/* The bar's axis: the period it measures, written as its two
                  endpoints. */}
              {periodRange ? (
                <div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground tabular-nums">
                  <span>{periodRange.start}</span>
                  <span>{periodRange.end}</span>
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">{hint}</span>
              )}
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {t("settings.planUsage.noAiIncluded")}
          </p>
        )}
      </div>

      {/* Credits live here rather than in a section of their own: they are
          the second of this card's two pools, and a separate titled card for
          them was a second place to look for one subject. A real footer, edge
          to edge, so the two pools read as one card with two floors. Withheld
          from a plan without `credits`. Fails OPEN like every other gate, so
          a gateway blip still lets an org pay. The balance is the ONE amount this card may show, and only
          once the bar is full: that is the moment credits are what the org is
          spending. */}
      {canBuyCredits && (
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 px-6 py-4 border-t border-border bg-muted/30">
          {state === "exhausted" && creditsUsd !== null && (
            <span className="text-sm font-medium tabular-nums">
              {creditsUsd.toLocaleString(preferences.language, {
                style: "currency",
                currency: "USD",
              })}{" "}
              <span className="text-muted-foreground font-normal">
                {t("settings.planUsage.creditsLeft")}
              </span>
            </span>
          )}
          {/* `ml-auto` rather than relying on `justify-between`: on a bar that
              is not full there is no balance, and the controls still belong on
              the right. */}
          <div className="ml-auto flex flex-wrap items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {t("settings.decoCreditsHero.addCredits")}
            </span>
            <QuickTopUp />
          </div>
        </div>
      )}
    </Card>
  );
}
