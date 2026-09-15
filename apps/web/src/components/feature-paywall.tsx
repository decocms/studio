/**
 * The paywall — what this org's plan does not include, shown where the user
 * reached for it. A popup rather than a hidden button: the org has to be able
 * to see what it would get, and the upsell is the point.
 *
 * Product gating only. The gateway is what actually refuses the spend; a
 * dismissed paywall is not a granted feature.
 */

import { Check, Lock01 } from "@untitledui/icons";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { PaywallDialog } from "@/components/paywall/paywall-dialog";
import {
  PlanPlant,
  planAccent,
  planPrice,
  formatPlanPrice,
  usePlanPrices,
  planUnlocking,
  usePlanCatalog,
} from "@/views/settings/ai-providers/plan-ladder";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useProjectContext } from "@/sdk";
import { useT } from "@/i18n/use-t.ts";
import { useEntitlements, type Feature } from "@/hooks/use-entitlements";
import type { Plan } from "@/views/settings/ai-providers/plan-ladder";

/** The rung above the org's current one, or null at the top of the ladder. */
function nextRung(
  plans: Plan[] | undefined,
  currentId: string | undefined,
): { plan: Plan; index: number } | null {
  if (!plans || !currentId) return null;
  const index = plans.findIndex((p) => p.id === currentId) + 1;
  const plan = index > 0 ? plans[index] : undefined;
  return plan ? { plan, index } : null;
}

/**
 * What the locked feature DOES, in three scannable lines — the only three gates
 * that reach this dialog. Not the tier's full feature list, which was the plans
 * page in miniature: it answered "what else comes with it" to someone who asked
 * "what is the thing I just clicked".
 */
const FEATURE_BULLETS = {
  kanban: [
    "settings.paywall.bullets.kanban.1",
    "settings.paywall.bullets.kanban.2",
    "settings.paywall.bullets.kanban.3",
  ],
  cms: [
    "settings.paywall.bullets.cms.1",
    "settings.paywall.bullets.cms.2",
    "settings.paywall.bullets.cms.3",
  ],
  monitoring: [
    "settings.paywall.bullets.monitoring.1",
    "settings.paywall.bullets.monitoring.2",
    "settings.paywall.bullets.monitoring.3",
  ],
} as const satisfies Partial<Record<Feature, readonly string[]>>;

/** The spent-allowance case, which is not a missing feature and so has no
 *  entry above: the org HAS chat and ran out of room to run it. */
const ALLOWANCE_BULLETS = [
  "settings.paywall.bullets.allowance.1",
  "settings.paywall.bullets.allowance.2",
  "settings.paywall.bullets.allowance.3",
] as const;

export function FeaturePaywall({
  feature,
  copy,
  onDismiss,
  onSeePlans,
}: {
  feature: Feature;
  /**
   * Override the "your plan doesn't include X" copy. One caller needs it: a
   * spent AI allowance is not a missing feature — the org HAS chat, it has run
   * out — and the dialog, the CTA and the plan card it lands on are otherwise
   * identical. Cheaper than a second dialog that would drift from this one.
   */
  copy?: { title: string; description?: string };
  /** "Not now", an outside click, Esc. */
  onDismiss?: () => void;
  /**
   * "See plans", AFTER the navigation to the plan card. Separate from
   * `onDismiss` because the two intents need different handling: one caller's
   * dismiss also closes the main panel, and firing that on "See plans" ran a
   * second, route-relative `replace: true` navigation in the same tick, which
   * won — so the primary upsell CTA closed the panel and never reached the
   * plans. Defaults to `onDismiss` for callers where closing IS the right
   * follow-up.
   */
  onSeePlans?: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const { org } = useProjectContext();
  const { data: plans } = usePlanCatalog();
  const { data: entitlements } = useEntitlements();
  const { data: prices } = usePlanPrices();
  const [preferences] = usePreferences();
  // The same names the plan picker lists, so the upsell and the plan card
  // call the feature the same thing.
  const name = t(`settings.planUsage.feature.${feature}`);
  /** The rung to climb to. For a missing feature it is the cheapest one that
   *  has it; for a spent allowance nothing is missing, so it is simply the
   *  next rung up from where the org already is. */
  const target = copy
    ? nextRung(plans, entitlements?.plan.id)
    : planUnlocking(plans, feature);
  const accent = target ? planAccent(target.index) : undefined;
  const price = target ? planPrice(prices, target.plan.id) : undefined;
  const bullets = copy
    ? ALLOWANCE_BULLETS
    : feature in FEATURE_BULLETS
      ? FEATURE_BULLETS[feature as keyof typeof FEATURE_BULLETS]
      : null;

  return (
    <PaywallDialog
      onDismiss={onDismiss}
      accentClassName={accent}
      icon={
        target ? (
          <PlanPlant index={target.index} className="size-20" />
        ) : (
          <Lock01 className="size-12 text-muted-foreground" />
        )
      }
      title={
        copy?.title ??
        (target
          ? t("settings.paywall.upgradeTitle", {
              plan: target.plan.name,
              feature: name,
            })
          : name)
      }
      description={
        copy?.description ??
        (bullets
          ? undefined
          : target
            ? t("settings.paywall.upgradeDescription")
            : t("settings.paywall.description", { feature: name }))
      }
      highlights={
        bullets && (
          <ul className="flex flex-col gap-2.5 text-left">
            {bullets.map((key) => (
              <li key={key} className="flex items-center gap-3 text-sm">
                <Check size={16} className={cn("shrink-0", accent)} />
                <span>{t(key)}</span>
              </li>
            ))}
          </ul>
        )
      }
      price={
        price !== undefined ? (
          <span className="flex items-baseline justify-center gap-1.5">
            <span className="text-2xl font-semibold tabular-nums tracking-tight">
              {formatPlanPrice(price, preferences.language)}
            </span>
            <span className="text-sm text-muted-foreground">
              {t("settings.plans.perMonth")}
            </span>
          </span>
        ) : undefined
      }
      action={
        <Button
          size="lg"
          className="w-full"
          onClick={() => {
            navigate({
              to: "/$org/settings/ai-providers",
              params: { org: org.slug },
            });
            (onSeePlans ?? onDismiss)?.();
          }}
        >
          {t("settings.paywall.seePlans")}
        </Button>
      }
      dismissAction={
        <Button
          variant="ghost"
          size="lg"
          className="w-full"
          onClick={onDismiss}
        >
          {t("settings.paywall.dismiss")}
        </Button>
      }
    />
  );
}
