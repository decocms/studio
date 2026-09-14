import { useQuery } from "@tanstack/react-query";
import { Button } from "@decocms/ui/components/button.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Progress } from "@decocms/ui/components/progress.tsx";
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

const BAR_STYLES = {
  ok: "[&>[data-slot=progress-indicator]]:bg-primary",
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

export function PlanUsageCard() {
  const t = useT();
  const [preferences] = usePreferences();

  const plansEnabled = usePlansEnabled();
  // Free cannot top up: its allowance is a ceiling and the only way past it is
  // a plan. That changes both the copy and whether a credits row belongs here.
  const canBuyCredits = useFeature("credits");
  const { data, isLoading, isError, refetch } = useEntitlements();

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
  // A real calendar date, from the gateway's own roll rule — not "next month".
  // Guarded: a missing or unparseable date falls back to the generic hint
  // rather than rendering the literal string "Invalid Date" at the user.
  const periodEndAt = data.periodEnd ? new Date(data.periodEnd) : null;
  // The gateway sends a period_end for free too, and free never refills.
  const renews = data.plan.id !== "free";
  const resetsOn =
    renews && periodEndAt && !Number.isNaN(periodEndAt.getTime())
      ? periodEndAt.toLocaleDateString(preferences.language, {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : null;

  const hint =
    state === "exhausted"
      ? canBuyCredits
        ? resetsOn
          ? t("settings.planUsage.exhaustedHintOn", { date: resetsOn })
          : t("settings.planUsage.exhaustedHint")
        : resetsOn
          ? t("settings.planUsage.exhaustedUpgradeOnlyOn", { date: resetsOn })
          : t("settings.planUsage.exhaustedUpgradeOnly")
      : resetsOn
        ? t("settings.planUsage.resetsOn", { date: resetsOn })
        : renews
          ? t("settings.planUsage.periodHint")
          : t("settings.planUsage.oneTimeHint");

  return (
    <SettingsSection title={t("settings.planUsage.title")}>
      <SettingsCard>
        <div className="px-5 py-5 flex flex-col gap-6">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-xs text-muted-foreground">
                {t("settings.planUsage.currentPlan")}
              </span>
              <div className="flex items-center gap-2.5">
                <span className="text-2xl font-semibold leading-none tracking-tight">
                  {data.plan.name}
                </span>
                {hasAiEnvelope && state === "exhausted" && (
                  <Badge variant="destructive">
                    {t("settings.planUsage.exhausted")}
                  </Badge>
                )}
              </div>
            </div>
            <ManageBillingButton />
          </div>

          {hasAiEnvelope ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  {t("settings.planUsage.aiUsage")}
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  {percent === null
                    ? t("settings.planUsage.usageUnavailable")
                    : `${percent}%`}
                </span>
              </div>
              {/* No bar at all when consumption is UNKNOWN. `value={percent ??
                  0}` rendered a full-width EMPTY track, which is the one
                  reading this card's own docstring forbids: an empty bar says
                  "nothing used", and the honest answer is "we could not read
                  it". The label above already says Unavailable; this is a
                  placeholder track with no fill, not a measurement. */}
              {percent === null ? (
                <div
                  className="h-2 w-full rounded-full bg-muted/60"
                  aria-hidden="true"
                />
              ) : (
                <Progress value={percent} className={cn(BAR_STYLES[state])} />
              )}
              <p className="text-xs text-muted-foreground">{hint}</p>
              {/* The second pool, and the ONE amount this card may show. It
                  appears only once the bar is full, because that is the only
                  moment credits are what the org is spending — showing a
                  balance alongside a half-empty bar is what made the two read
                  as one number. */}
              {state === "exhausted" &&
                canBuyCredits &&
                creditsUsd !== null && (
                  <div className="flex items-baseline justify-between gap-2 pt-2 mt-1 border-t border-border">
                    <span className="text-xs text-muted-foreground">
                      {creditsUsd > 0
                        ? t("settings.planUsage.creditsHint")
                        : t("settings.planUsage.creditsEmpty")}
                    </span>
                    <span className="text-sm font-semibold tabular-nums shrink-0">
                      {t("settings.planUsage.credits", {
                        amount: creditsUsd.toLocaleString(
                          preferences.language,
                          { style: "currency", currency: "USD" },
                        ),
                      })}
                    </span>
                  </div>
                )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("settings.planUsage.noAiIncluded")}
            </p>
          )}

          {/* Credits live here rather than in a section of their own: they are
              the second of this card's two pools, and a separate titled card
              for them was a second place to look for one subject. Withheld
              from a plan without `credits` (Free), whose allowance is a
              ceiling. Fails OPEN like every other gate, so a gateway blip
              still lets an org pay. */}
          {canBuyCredits && (
            <div className="flex flex-col gap-2.5 pt-5 border-t border-border">
              <p className="text-sm text-muted-foreground">
                {t("settings.decoCreditsHero.addCredits")}
              </p>
              <QuickTopUp />
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
