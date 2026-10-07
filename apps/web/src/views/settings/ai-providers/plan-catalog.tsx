import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Minus } from "@untitledui/icons";
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
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { SettingsSection } from "@/components/settings/settings-section";
import { useT } from "@/i18n/use-t.ts";
import { useEntitlements, usePlansEnabled } from "@/hooks/use-entitlements";
import {
  FEATURE_ROWS,
  PlanPlant,
  SALES_CONTACT_HREF,
  formatPlanPrice,
  isStaffManagedPlan,
  usePlanPrices,
  usePlanCatalog,
  type Plan,
  type PlanPrice,
} from "./plan-ladder";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useOpenBillingUrl } from "@/hooks/use-open-billing-url";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";

/**
 * The plans, side by side, on the page.
 *
 * This used to be a dialog behind a "Change plan" button: four rows with a
 * feature subtitle each, opened from a card that already said which plan the
 * org was on. Comparing plans is the whole decision, and a dialog gave it four
 * lines. Inline, every plan gets the same feature rows in the same order, so
 * what a tier adds is read down a column and across a row.
 *
 * Allowances stay on the gateway; prices come from Stripe (`usePlanPrices`).
 * Custom is not in the gateway's public list — deco staff assign it by
 * contract — so it is a static card here with no price, only a contact.
 *
 * An org deco flagged `invoice_upgrade` may also take a plan now and pay for
 * it on its deco invoice (`AI_PLAN_INVOICE_UPGRADE`) — on a contract plan,
 * only once its AI usage is spent.
 */

/** The plans `AI_PLAN_INVOICE_UPGRADE` accepts. */
function invoicePlanId(id: string): "starter" | "business" | null {
  return id === "starter" || id === "business" ? id : null;
}

export function PlanCatalog() {
  const t = useT();
  const plansEnabled = usePlansEnabled();
  const {
    data: entitlements,
    isLoading: isLoadingPlan,
    isError: planFailed,
  } = useEntitlements();

  const { data: plans, isLoading, isError, refetch } = usePlanCatalog();
  const { data: prices } = usePlanPrices();

  // A plan is a purchase, so it goes to Stripe and the tier arrives from the
  // webhook.
  const { mutate: startCheckout, isPending } = useOpenBillingUrl(
    "ORGANIZATION_BILLING_CHECKOUT_START",
    "settings.planUsage.changeFailed",
  );

  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();
  // Only a flagged org, and only at its limit — the same two conditions
  // AI_PLAN_INVOICE_UPGRADE enforces, so the button never offers a refusal.
  const canInvoice =
    entitlements?.features.invoice_upgrade === true &&
    entitlements.usage?.state === "exhausted";
  // Same query as the plan card's billing button. A live subscription owns the
  // plan, so the invoice path waits for a definite "none" before it shows.
  const { data: billingAccount } = useQuery({
    queryKey: KEYS.orgBillingAccount(org.id),
    enabled: canInvoice,
    staleTime: 60_000,
    queryFn: () => studio.call("ORGANIZATION_TASK_QUOTA_GET", {}),
  });
  const offerInvoice = canInvoice && billingAccount?.subscribed === false;
  const [invoicePlan, setInvoicePlan] = useState<Plan | null>(null);
  const { mutate: invoiceUpgrade, isPending: isInvoicing } = useMutation({
    mutationFn: (planId: "starter" | "business") =>
      studio.call("AI_PLAN_INVOICE_UPGRADE", { planId }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: KEYS.aiPlanEntitlements(org.id),
      });
      toast.success(t("settings.planUsage.changed"));
    },
    onError: (err) =>
      toast.error(
        t("settings.planUsage.changeFailed", { message: err.message }),
      ),
  });

  // Without the org's plan we cannot tell a contract org from any other, and
  // the catalog is exactly what a contract org must not be shown. The plan
  // card above already says the read failed and offers the retry.
  if (!plansEnabled || planFailed) return null;

  const currentId = entitlements?.plan.id ?? null;

  const staffManaged = isStaffManagedPlan(currentId);
  const limitReached = staffManaged && canInvoice;

  if (staffManaged && !limitReached) {
    return (
      <SettingsSection title={t("settings.plans.title")}>
        <Card className="p-5 flex-row items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("settings.plans.managed", {
              plan: entitlements?.plan.name ?? "",
            })}
          </p>
          <Button variant="outline" size="sm" asChild>
            <a href={SALES_CONTACT_HREF}>{t("settings.plans.custom.cta")}</a>
          </Button>
        </Card>
      </SettingsSection>
    );
  }

  // The tier right after the current one is the one most orgs are deciding
  // about, so it gets the primary button; the rest stay quiet. With no plan
  // the index is -1, which makes that the first tier — the trial.
  const currentIndex = plans?.findIndex((p) => p.id === currentId) ?? -1;
  const suggestedId = plans?.[currentIndex + 1]?.id ?? null;
  // An org already paying for a tier does not "Subscribe" to another one — it
  // moves the subscription it has, on Stripe's own confirm screen. Same
  // button, and the word is the only thing that says which of the two it is.
  // `free` is the absence of a plan, not one.
  // A contract org has no plan Stripe knows about; ask Stripe instead.
  const subscribed = limitReached
    ? billingAccount?.subscribed === true
    : currentId !== null && currentId !== "free";

  return (
    <SettingsSection
      title={
        limitReached
          ? t("settings.plans.limitReached")
          : t("settings.plans.title")
      }
    >
      {isLoading || isLoadingPlan ? (
        <div className="grid gap-4 md:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
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
        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((plan, index) => (
            <PlanCard
              key={plan.id}
              plan={plan}
              index={index}
              price={prices?.[plan.id]}
              subscribed={subscribed}
              isCurrent={plan.id === currentId}
              emphasis={plan.id === suggestedId}
              disabled={isPending || isInvoicing}
              onChoose={() => startCheckout(plan.id)}
              onInvoice={
                offerInvoice && invoicePlanId(plan.id)
                  ? () => setInvoicePlan(plan)
                  : undefined
              }
            />
          ))}
          {!limitReached && <CustomPlanCard index={plans.length} />}
        </div>
      )}

      <AlertDialog
        open={invoicePlan !== null}
        onOpenChange={(open) => !open && setInvoicePlan(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings.plans.invoice.cta")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings.plans.invoice.confirm", {
                plan: invoicePlan?.name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("settings.plans.invoice.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const planId = invoicePlan && invoicePlanId(invoicePlan.id);
                if (planId) invoiceUpgrade(planId);
              }}
            >
              {t("settings.plans.invoice.switch")}
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
  price,
  subscribed,
  isCurrent,
  emphasis,
  disabled,
  onChoose,
  onInvoice,
}: {
  plan: Plan;
  index: number;
  price: PlanPrice | undefined;
  subscribed: boolean;
  isCurrent: boolean;
  emphasis: boolean;
  disabled: boolean;
  onChoose: () => void;
  /** Set when the org may take this plan on its invoice instead of Stripe. */
  onInvoice?: () => void;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  // Starter's first month is a Stripe trial on a NEW subscription, so it is
  // only on offer to an org that has none.
  const trial = plan.id === "starter" && !subscribed;

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
          {/* While the prices load, EVERY card omits the line, so the row
              stays aligned and no card shows a number that is about to move. */}
          {price !== undefined && (
            <div className="flex flex-col gap-1">
              <span className="text-2xl font-semibold leading-none tracking-tight tabular-nums">
                {formatPlanPrice(price, preferences.language)}
              </span>
              <span className="text-sm text-muted-foreground">
                {t("settings.plans.perMonth")}
                {/* The trial is Stripe's; an invoiced plan bills from day one,
                    so beside that button the Stripe CTA alone names it. */}
                {trial && !onInvoice && (
                  <>
                    {" · "}
                    <span className="text-success font-medium">
                      {t("settings.plans.firstMonthFree")}
                    </span>
                  </>
                )}
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
        <div className="flex flex-col gap-2">
          <Button
            variant={emphasis ? "default" : "outline"}
            className="w-full"
            disabled={disabled}
            onClick={onChoose}
          >
            {subscribed
              ? t("settings.planUsage.changePlan")
              : trial
                ? t("settings.plans.startTrial")
                : t("settings.planUsage.subscribe")}
          </Button>
          {onInvoice && (
            <Button
              variant="outline"
              className="w-full"
              disabled={disabled}
              onClick={onInvoice}
            >
              {t("settings.plans.invoice.cta")}
            </Button>
          )}
        </div>
      )}

      <ul className="flex flex-col gap-3 pt-6 border-t border-border">
        {FEATURE_ROWS.map((feature) => {
          const included = plan.features[feature] === true;
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
              <span>{t(`settings.planUsage.feature.${feature}`)}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

/** Contract pricing, set by deco staff: no price to quote, only a contact. */
function CustomPlanCard({ index }: { index: number }) {
  const t = useT();
  return (
    <Card className="p-6 gap-6">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-medium leading-tight">
            {t("settings.plans.custom.name")}
          </h3>
          <span className="text-sm text-muted-foreground">
            {t("settings.plans.custom.description")}
          </span>
        </div>
        <PlanPlant index={index} />
      </div>
      <Button variant="outline" className="w-full" asChild>
        <a href={SALES_CONTACT_HREF}>{t("settings.plans.custom.cta")}</a>
      </Button>
    </Card>
  );
}
