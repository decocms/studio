/**
 * Shown when delegating a task to the Super Agent (task dialog submit, or the
 * lane/card assignee picker) is rejected with a `[SUBSCRIPTION_REQUIRED]`
 * error — see `is-subscription-error.ts` for the 3 cases this distinguishes.
 * Billing itself is never built here: `ORGANIZATION_BILLING_CHECKOUT_START`
 * returns Stripe's hosted checkout URL, opened in a new tab like every other
 * checkout in the app (`deco-credits-hero.tsx`).
 *
 * `trial_exhausted` is the only case with something to sell — it gets the
 * richer benefits/price layout (same shell as `backlog-paywall.tsx`'s modal,
 * per the "only one visual paywall pattern on the board" rule). The other two
 * are purely informational (quota renews on its own / make a new task), so
 * they stay a plain title + description.
 */
import { CheckCircle, Loading01 } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@decocms/ui/components/dialog.tsx";
import { useOpenBillingUrl } from "@/hooks/use-open-billing-url";
import { useT } from "@/i18n/use-t.ts";
import type { SubscriptionErrorKind } from "@/components/task-board/is-subscription-error";
import { KANBAN_PREVIEW_SRC } from "./backlog-paywall";

const BENEFIT_KEYS = [
  "taskBoard.subscriptionPaywall.trialBenefitMonitoring",
  "taskBoard.subscriptionPaywall.trialBenefitAutoFix",
  "taskBoard.subscriptionPaywall.trialBenefitRuns",
] as const;

export function SubscriptionPaywallDialog({
  kind,
  onOpenChange,
}: {
  kind: SubscriptionErrorKind | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();

  const { mutate: subscribe, isPending } = useOpenBillingUrl(
    "ORGANIZATION_BILLING_CHECKOUT_START",
    "taskBoard.subscriptionPaywall.checkoutError",
  );

  if (kind === "trial_exhausted") {
    return (
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent
          className="gap-0 p-3 sm:max-w-[440px]"
          closeButtonClassName="z-10 rounded-full bg-background/70 p-1 text-foreground backdrop-blur transition-colors hover:bg-background"
        >
          {/* Same hero as backlog-paywall.tsx's modal — one board-preview
              image, not a second asset. */}
          <div className="overflow-hidden rounded-xl bg-muted">
            <img
              src={KANBAN_PREVIEW_SRC}
              alt={t("taskBoard.subscriptionPaywall.previewAlt")}
              className="h-[160px] w-full object-cover object-left-top"
            />
          </div>

          <div className="flex flex-col gap-6 px-3 pb-3 pt-7">
            <DialogTitle className="text-xl font-semibold text-foreground">
              {t("taskBoard.subscriptionPaywall.trialTitle")}
            </DialogTitle>
            <ul className="flex flex-col gap-3">
              {BENEFIT_KEYS.map((key) => (
                <li key={key} className="flex items-start gap-3 text-sm">
                  <CheckCircle
                    size={18}
                    className="mt-0.5 shrink-0 text-success"
                    aria-hidden
                  />
                  <span className="leading-snug text-foreground">{t(key)}</span>
                </li>
              ))}
            </ul>
            {/* Price + actions — stacked full-width on mobile, price-left /
                buttons-right on sm+ (matches backlog-paywall.tsx's modal). */}
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-baseline gap-1.5">
                <span className="text-2xl font-semibold text-foreground">
                  {t("taskBoard.subscriptionPaywall.trialPrice")}
                </span>
                <span className="text-sm text-muted-foreground">
                  {t("taskBoard.subscriptionPaywall.trialPricePeriod")}
                </span>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
                <Button
                  variant="ghost"
                  onClick={() => onOpenChange(false)}
                  disabled={isPending}
                  className="order-2 w-full sm:order-none sm:w-auto"
                >
                  {t("taskBoard.subscriptionPaywall.notNowButton")}
                </Button>
                <Button
                  disabled={isPending}
                  onClick={() =>
                    subscribe(undefined, {
                      onSuccess: () => onOpenChange(false),
                    })
                  }
                  className="order-1 w-full gap-2 sm:order-none sm:w-auto"
                >
                  {isPending && (
                    <Loading01 size={16} className="animate-spin" />
                  )}
                  {t("taskBoard.subscriptionPaywall.subscribeButton")}
                </Button>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const copy = kind
    ? {
        monthly_exhausted: {
          title: t("taskBoard.subscriptionPaywall.monthlyTitle"),
          description: t("taskBoard.subscriptionPaywall.monthlyDescription"),
        },
        runs_exhausted: {
          title: t("taskBoard.subscriptionPaywall.runsTitle"),
          description: t("taskBoard.subscriptionPaywall.runsDescription"),
        },
      }[kind]
    : null;

  return (
    <Dialog open={!!kind} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{copy?.title}</DialogTitle>
          <DialogDescription>{copy?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("taskBoard.subscriptionPaywall.dismissButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
