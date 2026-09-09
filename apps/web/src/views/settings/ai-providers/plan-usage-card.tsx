import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@decocms/ui/components/button.tsx";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Progress } from "@decocms/ui/components/progress.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/settings-section";
import { useProjectContext } from "@/sdk";
import { useStudioTools } from "@/lib/studio-tools";
import { KEYS } from "@/lib/query-keys";
import { useT } from "@/i18n/use-t.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useEntitlements, usePlansEnabled } from "@/hooks/use-entitlements";

/**
 * The org's plan and its AI usage bar.
 *
 * The bar is a PERCENT and nothing else — no dollars, no tokens (that is the
 * pricing decision, not a shortcut): the only place money appears is a wallet
 * top-up. `usage: null` means the gateway could not read consumption, which
 * must read as unknown; an empty bar would tell the org it has spent nothing.
 */

const BAR_STYLES = {
  ok: "[&>[data-slot=progress-indicator]]:bg-primary",
  warn: "[&>[data-slot=progress-indicator]]:bg-warning",
  exhausted: "[&>[data-slot=progress-indicator]]:bg-destructive",
} as const;

/** The features worth naming in a plan picker, in the order they read. */
const HIGHLIGHT_FEATURES = [
  "cms",
  "chat",
  "monitoring",
  "kanban",
  "model_choice",
] as const;

function ChangePlanDialog({
  open,
  onOpenChange,
  currentPlanId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPlanId: string;
}) {
  const t = useT();
  const { org } = useProjectContext();
  const studio = useStudioTools();
  const queryClient = useQueryClient();

  const { data: plans } = useQuery({
    queryKey: KEYS.aiPlanCatalog(org.id),
    enabled: open,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { plans } = await studio.call("AI_PLAN_LIST", {
        providerId: "deco",
      });
      return plans;
    },
  });

  const { mutate: choosePlan, isPending } = useMutation({
    mutationFn: async (planId: string) => {
      await studio.call("AI_PLAN_SET", { providerId: "deco", planId });
      // The card is the source of truth for what the org is on — refetch it
      // rather than reading the mutation's own response. A throw in onSuccess
      // is caught by react-query and surfaced as a mutation ERROR, so trusting
      // a response shape here turns a successful switch into "Couldn't change
      // plan: Cannot read properties of undefined".
      return await queryClient.invalidateQueries({
        queryKey: KEYS.aiPlanEntitlements(org.id),
      });
    },
    onSuccess: () => {
      toast.success(t("settings.planUsage.changed"));
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast.error(
        t("settings.planUsage.changeFailed", { message: err.message }),
      );
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.planUsage.changePlan")}</DialogTitle>
          <DialogDescription>
            {t("settings.planUsage.changePlanDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {!plans
            ? Array.from({ length: 3 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton
                <Skeleton key={i} className="h-14 w-full" />
              ))
            : plans.map((plan) => {
                const isCurrent = plan.id === currentPlanId;
                const included = HIGHLIGHT_FEATURES.filter(
                  (f) => plan.features[f],
                );
                return (
                  <button
                    key={plan.id}
                    type="button"
                    disabled={isCurrent || isPending}
                    onClick={() => choosePlan(plan.id)}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-lg border px-4 py-3 text-left transition-colors",
                      isCurrent
                        ? "border-primary bg-primary/5 cursor-default"
                        : "border-border hover:bg-muted/50",
                      isPending && !isCurrent && "opacity-50",
                    )}
                  >
                    <div className="flex flex-col gap-0.5 min-w-0">
                      <span className="text-sm font-medium">{plan.name}</span>
                      <span className="text-xs text-muted-foreground truncate">
                        {included.length > 0
                          ? included
                              .map((f) => t(`settings.planUsage.feature.${f}`))
                              .join(" · ")
                          : t("settings.planUsage.feature.none")}
                      </span>
                    </div>
                    {isCurrent && (
                      <Badge variant="secondary">
                        {t("settings.planUsage.current")}
                      </Badge>
                    )}
                  </button>
                );
              })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PlanUsageCard() {
  const t = useT();
  const [preferences] = usePreferences();
  const [changeOpen, setChangeOpen] = useState(false);

  const plansEnabled = usePlansEnabled();
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
            <Skeleton className="h-16 w-full" />
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

  const percent = data.usage ? Math.round(data.usage.percent * 100) : null;
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
  const resetsOn =
    periodEndAt && !Number.isNaN(periodEndAt.getTime())
      ? periodEndAt.toLocaleDateString(preferences.language, {
          day: "numeric",
          month: "long",
          year: "numeric",
        })
      : null;

  return (
    <SettingsSection title={t("settings.planUsage.title")}>
      <SettingsCard>
        <div className="px-5 py-5 flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-1 min-w-0">
              <span className="text-xs text-muted-foreground">
                {t("settings.planUsage.currentPlan")}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-xl font-semibold leading-tight">
                  {data.plan.name}
                </span>
                {hasAiEnvelope && state === "exhausted" && (
                  <Badge variant="destructive">
                    {t("settings.planUsage.exhausted")}
                  </Badge>
                )}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setChangeOpen(true)}
            >
              {t("settings.planUsage.changePlan")}
            </Button>
          </div>

          {hasAiEnvelope ? (
            <div className="flex flex-col gap-2 pt-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("settings.planUsage.aiUsage")}
                </span>
                <span className="text-sm font-semibold tabular-nums">
                  {percent === null
                    ? t("settings.planUsage.usageUnavailable")
                    : `${percent}%`}
                </span>
              </div>
              <Progress
                value={percent ?? 0}
                className={cn(percent !== null && BAR_STYLES[state])}
              />
              <p className="text-xs text-muted-foreground">
                {state === "exhausted"
                  ? resetsOn
                    ? t("settings.planUsage.exhaustedHintOn", {
                        date: resetsOn,
                      })
                    : t("settings.planUsage.exhaustedHint")
                  : resetsOn
                    ? t("settings.planUsage.resetsOn", { date: resetsOn })
                    : t("settings.planUsage.periodHint")}
              </p>
              {/* The second pool, and the ONE amount this card may show. It
                  appears only once the bar is full, because that is the only
                  moment credits are what the org is spending — showing a
                  balance alongside a half-empty bar is what made the two read
                  as one number. */}
              {state === "exhausted" && creditsUsd !== null && (
                <div className="flex items-baseline justify-between gap-2 pt-1 border-t border-border mt-1">
                  <span className="text-xs text-muted-foreground">
                    {creditsUsd > 0
                      ? t("settings.planUsage.creditsHint")
                      : t("settings.planUsage.creditsEmpty")}
                  </span>
                  <span className="text-sm font-semibold tabular-nums shrink-0">
                    {t("settings.planUsage.credits", {
                      amount: creditsUsd.toLocaleString(preferences.language, {
                        style: "currency",
                        currency: "USD",
                      }),
                    })}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground pt-1">
              {t("settings.planUsage.noAiIncluded")}
            </p>
          )}
        </div>
      </SettingsCard>

      <ChangePlanDialog
        open={changeOpen}
        onOpenChange={setChangeOpen}
        currentPlanId={data.plan.id}
      />
    </SettingsSection>
  );
}
