/**
 * Auto tasks quota card — merged onto the AI Providers page (it was the only
 * card behind the old "Plan & usage" tab). Gated on `members:manage` since
 * that's a different capability than `ai-providers:manage`, which guards the
 * rest of this page.
 */
import { useQuery } from "@tanstack/react-query";
import { CreditCard01, Loading01 } from "@untitledui/icons";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Button } from "@decocms/ui/components/button.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Progress } from "@decocms/ui/components/progress.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  SettingsCard,
  SettingsCardItem,
} from "@/components/settings/settings-section";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { useCapability } from "@/hooks/use-capability";
import { useOpenBillingUrl } from "@/hooks/use-open-billing-url";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";

const PERIOD_END_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** Status pill: paying (good standing) / payment issue (Stripe dunning) /
 *  free trial (never subscribed, or a canceled subscription). */
function StatusBadge({
  billingStatus,
  subscribed,
  t,
}: {
  billingStatus: string;
  subscribed: boolean;
  t: ReturnType<typeof useT>;
}) {
  if (subscribed && billingStatus === "past_due") {
    return (
      <Badge variant="warning">{t("settings.billing.statusPastDue")}</Badge>
    );
  }
  if (subscribed) {
    return (
      <Badge variant="success">{t("settings.billing.statusActive")}</Badge>
    );
  }
  return <Badge variant="secondary">{t("settings.billing.statusTrial")}</Badge>;
}

function AutoTasksCardContent() {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const checkout = useOpenBillingUrl(
    "ORGANIZATION_BILLING_CHECKOUT_START",
    "settings.billing.checkoutError",
  );
  const portal = useOpenBillingUrl(
    "ORGANIZATION_BILLING_PORTAL",
    "settings.billing.portalError",
  );

  const { data, isLoading } = useQuery({
    queryKey: KEYS.organizationTaskQuota(org.id),
    queryFn: () => studio.call("ORGANIZATION_TASK_QUOTA_GET", {}),
  });

  if (isLoading) {
    return (
      <SettingsCard>
        <div className="flex flex-col gap-3 px-4 py-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-2 w-full" />
        </div>
      </SettingsCard>
    );
  }

  // Self-hosted deployments never enforce the quota — nothing to manage.
  if (!data || !data.enforced) {
    return (
      <SettingsCard>
        <SettingsCardItem
          icon={<CreditCard01 size={16} />}
          title={t("settings.billing.autoTasksTitle")}
          description={t("settings.billing.unlimitedDescription")}
        />
      </SettingsCard>
    );
  }

  const { billingStatus, subscribed, hasBillingAccount, used, limit } = data;
  const usedPct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  const nearLimit = used >= limit;

  return (
    <SettingsCard>
      <div className="flex flex-col gap-5 px-5 py-5">
        {/* Provider info and actions */}
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="size-9 shrink-0 rounded-lg bg-muted/60 flex items-center justify-center text-muted-foreground">
              <CreditCard01 size={16} />
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-foreground">
                  {t("settings.billing.autoTasksTitle")}
                </span>
                <StatusBadge
                  billingStatus={billingStatus}
                  subscribed={subscribed}
                  t={t}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {subscribed
                  ? t("settings.billing.autoTasksDescriptionSubscribed")
                  : t("settings.billing.autoTasksDescriptionTrial")}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {hasBillingAccount && (
              <Button
                variant="outline"
                size="sm"
                disabled={portal.isPending}
                onClick={() => portal.mutate()}
              >
                {portal.isPending && (
                  <Loading01 size={14} className="animate-spin" />
                )}
                {t("settings.billing.manageButton")}
              </Button>
            )}
            {!subscribed && (
              <Button
                size="sm"
                disabled={checkout.isPending}
                onClick={() => checkout.mutate()}
              >
                {checkout.isPending && (
                  <Loading01 size={14} className="animate-spin" />
                )}
                {t("settings.billing.subscribeButton")}
              </Button>
            )}
          </div>
        </div>

        {/* Usage */}
        <div className="flex flex-col gap-2.5 pt-4 border-t border-border/60">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className={cn(
                "text-2xl font-semibold tabular-nums tracking-tight",
                nearLimit ? "text-warning" : "text-foreground",
              )}
            >
              {used}
              <span className="text-sm font-normal text-muted-foreground">
                {" "}
                / {limit}
              </span>
            </span>
            {subscribed && data.currentPeriodEnd && (
              <span className="text-xs text-muted-foreground">
                {t("settings.billing.renewsOn", {
                  date: PERIOD_END_FMT.format(new Date(data.currentPeriodEnd)),
                })}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("settings.billing.runsUsedLabel")}
          </p>
          <Progress value={usedPct} className="h-1.5" />
        </div>
      </div>
    </SettingsCard>
  );
}

export function AutoTasksCard() {
  const { granted } = useCapability("members:manage");
  if (!granted) return null;
  return <AutoTasksCardContent />;
}
