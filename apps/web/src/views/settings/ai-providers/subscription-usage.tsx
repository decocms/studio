import { useQuery } from "@tanstack/react-query";
import { RefreshCw01, ArrowUpRight } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

type Usage = StudioToolOutput<"SUBSCRIPTION_USAGE_GET">;
type Window = Usage["windows"][number];
function windowLabel(window: Window, t: TFunction): string {
  if (window.id === "seven_day_sonnet")
    return t("settings.subscriptionUsage.sonnet");
  if (window.id === "seven_day_opus")
    return t("settings.subscriptionUsage.opus");
  if (window.id.startsWith("code_review_"))
    return t("settings.subscriptionUsage.codeReview");
  if (window.windowSeconds === 18000)
    return t("settings.subscriptionUsage.fiveHour");
  if (window.windowSeconds === 604800)
    return t("settings.subscriptionUsage.weekly");
  if (window.windowSeconds)
    return t("settings.subscriptionUsage.hours", {
      hours: Math.round((window.windowSeconds / 3600) * 10) / 10,
    });
  return window.id === "secondary"
    ? t("settings.subscriptionUsage.secondary")
    : t("settings.subscriptionUsage.primary");
}

export function SubscriptionUsage({
  provider,
  orgId,
  userId,
  linkedAt,
}: {
  provider: "codex" | "claude";
  orgId: string;
  userId: string;
  linkedAt: string | null;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const studio = useStudioTools();
  const query = useQuery({
    queryKey: KEYS.subscriptionUsageSnapshot(orgId, userId, provider, linkedAt),
    queryFn: () => studio.call("SUBSCRIPTION_USAGE_GET", { provider }),
    enabled: Boolean(userId),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const usage = query.data;
  const date = (value: string) =>
    new Intl.DateTimeFormat(preferences.language, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));
  const issue = usage?.reason;
  const message =
    issue === "permission"
      ? t("settings.subscriptionUsage.permission")
      : issue === "authorization"
        ? t("settings.subscriptionUsage.authorization")
        : issue === "rate_limited"
          ? t("settings.subscriptionUsage.rateLimited")
          : usage?.status === "disconnected"
            ? t("settings.subscriptionUsage.disconnected")
            : t("settings.subscriptionUsage.unavailable");
  return (
    <section
      className="border-t border-border pt-4 space-y-4"
      aria-label={t("settings.subscriptionUsage.title")}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">
            {t("settings.subscriptionUsage.title")}
          </p>
          {usage?.limitReached === true && (
            <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
              {t("settings.subscriptionUsage.limitReached")}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
          aria-label={t("settings.subscriptionUsage.refresh")}
        >
          <RefreshCw01
            size={14}
            className={cn(query.isFetching && "animate-spin")}
          />
          {t("settings.subscriptionUsage.refresh")}
        </Button>
      </div>
      {query.isPending ? (
        <p className="text-sm text-muted-foreground" role="status">
          {t("settings.subscriptionUsage.loading")}
        </p>
      ) : query.isError || usage?.status !== "available" ? (
        <p className="text-sm text-muted-foreground" role="status">
          {message}
        </p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {usage.windows.map((window) => {
            const label = windowLabel(window, t);
            return (
              <div key={window.id} className="min-w-0 space-y-2">
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span>{label}</span>
                  <span
                    className={cn(
                      "shrink-0 tabular-nums font-medium",
                      window.usedPercent >= 100
                        ? "text-destructive"
                        : window.usedPercent >= 90
                          ? "text-warning"
                          : "text-foreground",
                    )}
                  >
                    {t("settings.subscriptionUsage.used", {
                      percent: Math.round(window.usedPercent),
                    })}
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-label={label}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={window.usedPercent}
                  className="h-1.5 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    style={{ width: `${window.usedPercent}%` }}
                    className={cn(
                      "h-full rounded-full",
                      window.usedPercent >= 100
                        ? "bg-destructive"
                        : window.usedPercent >= 90
                          ? "bg-warning"
                          : "bg-primary",
                    )}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {window.resetAt
                    ? t("settings.subscriptionUsage.resets", {
                        date: date(window.resetAt),
                      })
                    : t("settings.subscriptionUsage.resetUnknown")}
                </p>
              </div>
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-muted-foreground">
        <span>
          {usage?.retryAt
            ? t("settings.subscriptionUsage.retryAt", {
                date: date(usage.retryAt),
              })
            : usage?.checkedAt
              ? t("settings.subscriptionUsage.checkedAt", {
                  date: date(usage.checkedAt),
                })
              : t("settings.subscriptionUsage.sharedUsage")}
        </span>
        <a
          href={
            provider === "codex"
              ? "https://chatgpt.com/codex/settings/usage"
              : "https://claude.ai/settings/usage"
          }
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 hover:text-foreground"
        >
          {t("settings.subscriptionUsage.openProvider")}
          <ArrowUpRight size={12} />
        </a>
      </div>
      {usage?.status === "available" && (
        <p className="text-xs text-muted-foreground">
          {t("settings.subscriptionUsage.sharedUsage")}
        </p>
      )}
    </section>
  );
}
