import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Minus } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@decocms/ui/components/alert-dialog.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SettingsSection } from "@/components/settings/settings-section";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { useEntitlements, usePlansEnabled } from "@/hooks/use-entitlements";
import {
  FEATURE_ROWS,
  PlanPlant,
  planPriceBrl,
  PLAN_PRICE_CURRENCY,
  usePlanCatalog,
  type Plan,
} from "./plan-ladder";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useOpenBillingUrl } from "@/hooks/use-open-billing-url";

/**
 * The plans, side by side, on the page.
 *
 * This used to be a dialog behind a "Change plan" button: four rows with a
 * feature subtitle each, opened from a card that already said which plan the
 * org was on. Comparing plans is the whole decision, and a dialog gave it four
 * lines. Inline, every plan gets the same feature rows in the same order, so
 * what a tier adds is read down a column and across a row.
 *
 * Allowances stay on the gateway; the price is a placeholder (`planPriceBrl`).
 */

export function PlanCatalog() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  const plansEnabled = usePlansEnabled();
  const { data: entitlements } = useEntitlements();
  const [confirmDowngrade, setConfirmDowngrade] = useState(false);

  const { data: plans, isLoading, isError, refetch } = usePlanCatalog();

  // An UPGRADE is a purchase, so it goes to Stripe and the tier arrives from
  // the webhook. `AI_PLAN_SET` takes no payment and only accepts 'free', which
  // is the one transition that costs nothing and is the org's to make.
  const { mutate: startCheckout, isPending: isCheckingOut } = useOpenBillingUrl(
    "ORGANIZATION_BILLING_CHECKOUT_START",
    "settings.planUsage.changeFailed",
  );

  const { mutate: dropToFree, isPending: isDropping } = useMutation({
    mutationFn: async () => {
      await studio.call("AI_PLAN_SET", { providerId: "deco", planId: "free" });
      // The plan card is the source of truth for what the org is on — refetch
      // it rather than reading the mutation's own response.
      return await queryClient.invalidateQueries({
        queryKey: KEYS.aiPlanEntitlements(org.id),
      });
    },
    onSuccess: () => {
      toast.success(t("settings.planUsage.changed"));
      setConfirmDowngrade(false);
    },
    onError: (err: Error) => {
      toast.error(
        t("settings.planUsage.changeFailed", { message: err.message }),
      );
    },
  });

  if (!plansEnabled) return null;

  const currentId = entitlements?.plan.id ?? null;
  const currentName = entitlements?.plan.name ?? "";
  const isPending = isCheckingOut || isDropping;
  // The tier right after the current one is the one most orgs are deciding
  // about, so it gets the primary button; the rest stay quiet.
  const currentIndex = plans?.findIndex((p) => p.id === currentId) ?? -1;
  const suggestedId =
    currentIndex >= 0 ? (plans?.[currentIndex + 1]?.id ?? null) : null;

  return (
    <SettingsSection title={t("settings.plans.title")}>
      {isLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
            <Skeleton key={i} className="h-80 w-full rounded-xl" />
          ))}
        </div>
      ) : isError || !plans ? (
        <Card className="p-5 flex-row items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("settings.plans.loadFailed")}
          </p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>
            {t("settings.planUsage.retry")}
          </Button>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {plans.map((plan, index) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              index={index}
              isCurrent={plan.id === currentId}
              emphasis={plan.id === suggestedId}
              disabled={isPending}
              onChoose={() =>
                plan.id === "free"
                  ? setConfirmDowngrade(true)
                  : startCheckout(plan.id)
              }
            />
          ))}
        </div>
      )}

      {/* Dropping to Free used to be one click with a toast. It removes every
          gated feature the org has right away, so it asks first. */}
      <AlertDialog open={confirmDowngrade} onOpenChange={setConfirmDowngrade}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.plans.downgradeTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.plans.downgradeDescription", { plan: currentName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDropping}>
              {t("settings.plans.downgradeCancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={isDropping}
              onClick={(e) => {
                // Keep the dialog open until the mutation settles; onSuccess
                // closes it, onError leaves the org where it was.
                e.preventDefault();
                dropToFree();
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t("settings.planUsage.downgrade")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function PlanCard({
  plan,
  index,
  isCurrent,
  emphasis,
  disabled,
  onChoose,
}: {
  plan: Plan;
  index: number;
  isCurrent: boolean;
  emphasis: boolean;
  disabled: boolean;
  onChoose: () => void;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const price = planPriceBrl(plan.id);

  return (
    <Card
      className={cn(
        "p-6 gap-6",
        isCurrent && "ring-1 ring-primary shadow-none",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-medium leading-tight">{plan.name}</h3>
          {/* Free renders "R$0" rather than nothing: an absent line on one
              card alone would knock its button out of line with the rest. */}
          {price !== undefined && (
            <div className="flex flex-col gap-1">
              <span className="text-2xl font-semibold leading-none tracking-tight tabular-nums">
                {price.toLocaleString(preferences.language, {
                  style: "currency",
                  currency: PLAN_PRICE_CURRENCY,
                  maximumFractionDigits: 0,
                })}
              </span>
              <span className="text-sm text-muted-foreground">
                {t("settings.plans.perMonth")}
              </span>
            </div>
          )}
        </div>
        <PlanPlant index={index} />
      </div>

      {isCurrent ? (
        <div className="flex h-8 items-center justify-center rounded-md border border-dashed border-border text-sm text-muted-foreground">
          {t("settings.plans.currentPlan")}
        </div>
      ) : (
        <Button
          variant={emphasis ? "default" : "outline"}
          className="w-full"
          disabled={disabled}
          onClick={onChoose}
        >
          {plan.id === "free"
            ? t("settings.planUsage.downgrade")
            : t("settings.planUsage.subscribe")}
        </Button>
      )}

      <ul className="flex flex-col gap-3 pt-6 border-t border-border">
        {FEATURE_ROWS.map((feature) => {
          const included = plan.features[feature] === true;
          // A plan without `credits` is capped at its allowance and cannot buy
          // past it (Free). Listing "Chat" alongside the paid tiers reads as
          // the same chat they get, so say what it is.
          const label =
            feature === "chat" && included && !plan.features.credits
              ? t("settings.planUsage.feature.trialChat")
              : t(`settings.planUsage.feature.${feature}`);
          return (
            <li
              key={feature}
              className={cn(
                "flex items-center gap-2.5 text-sm",
                !included && "text-muted-foreground/70",
              )}
            >
              {included ? (
                <Check size={16} className="shrink-0 text-success" />
              ) : (
                <Minus
                  size={16}
                  className="shrink-0 text-muted-foreground/50"
                />
              )}
              <span>{label}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
