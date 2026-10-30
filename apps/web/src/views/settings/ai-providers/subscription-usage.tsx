import { useQuery } from "@tanstack/react-query";
import { AlertCircle, LinkExternal01, RefreshCw01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { DropdownMenuItem } from "@decocms/ui/components/dropdown-menu.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@decocms/ui/components/tooltip.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import type { StudioToolOutput } from "@decocms/shared/tools/tool-io";
import { useT, type TFunction } from "@/i18n/use-t.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { KEYS } from "@/lib/query-keys";
import { useStudioTools } from "@/lib/studio-tools";

type Provider = "codex" | "claude";
type Usage = StudioToolOutput<"SUBSCRIPTION_USAGE_GET">;
type Window = Usage["windows"][number];

const PROVIDER_USAGE_URL: Record<Provider, string> = {
  codex: "https://chatgpt.com/codex/settings/usage",
  claude: "https://claude.ai/settings/usage",
};

/** "5h", "7d", "Sonnet": short enough to sit beside a bar in a row. */
function shortLabel(window: Window, t: TFunction): string {
  if (window.id === "seven_day_sonnet") return "Sonnet";
  if (window.id === "seven_day_opus") return "Opus";
  if (window.id.startsWith("code_review_"))
    return t("settings.subscriptionUsage.codeReview");
  if (window.windowSeconds && window.windowSeconds % 86400 === 0)
    return `${window.windowSeconds / 86400}d`;
  if (window.windowSeconds)
    return `${Math.round((window.windowSeconds / 3600) * 10) / 10}h`;
  return window.id === "secondary"
    ? t("settings.subscriptionUsage.secondary")
    : t("settings.subscriptionUsage.primary");
}

function barColor(percent: number): string {
  if (percent >= 100) return "bg-destructive";
  if (percent >= 90) return "bg-warning";
  return "bg-foreground/70";
}

export function useSubscriptionUsage({
  provider,
  orgId,
  userId,
  linkedAt,
  enabled,
}: {
  provider: Provider;
  orgId: string;
  userId: string;
  linkedAt: string | null;
  enabled: boolean;
}) {
  const studio = useStudioTools();
  return useQuery({
    queryKey: KEYS.subscriptionUsageSnapshot(orgId, userId, provider, linkedAt),
    queryFn: () => studio.call("SUBSCRIPTION_USAGE_GET", { provider }),
    enabled: enabled && Boolean(userId),
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

/** The subscription's limits as compact bars, or one quiet line saying why not. */
export function SubscriptionUsageSummary({
  query,
}: {
  query: ReturnType<typeof useSubscriptionUsage>;
}) {
  const t = useT();
  const [preferences] = usePreferences();
  const usage = query.data;

  if (query.isPending) return <Skeleton className="h-4 w-32" />;

  if (query.isError || usage?.status !== "available") {
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
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex shrink-0 items-center gap-1 text-meta">
            <AlertCircle size={12} />
            {t("settings.subscriptionUsage.unavailableShort")}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{message}</TooltipContent>
      </Tooltip>
    );
  }

  if (usage.limitReached) {
    return (
      <Badge variant="destructive" size="sm">
        {t("settings.subscriptionUsage.limitReached")}
      </Badge>
    );
  }

  const date = (value: string) =>
    new Intl.DateTimeFormat(preferences.language, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(value));

  return (
    <div className="flex shrink-0 items-center gap-4">
      {usage.windows.slice(0, 2).map((window) => {
        const percent = Math.round(window.usedPercent);
        return (
          <Tooltip key={window.id}>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-2">
                <span className="text-meta">{shortLabel(window, t)}</span>
                <div
                  role="progressbar"
                  aria-label={shortLabel(window, t)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={percent}
                  className="h-1.5 w-14 overflow-hidden rounded-full bg-muted"
                >
                  <div
                    style={{ width: `${Math.min(100, percent)}%` }}
                    className={cn("h-full rounded-full", barColor(percent))}
                  />
                </div>
                <span className="w-8 text-right text-meta text-foreground">
                  {percent}%
                </span>
              </div>
            </TooltipTrigger>
            {window.resetAt && (
              <TooltipContent>
                {t("settings.subscriptionUsage.resets", {
                  date: date(window.resetAt),
                })}
              </TooltipContent>
            )}
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Refresh and the provider's own usage page, for the row's overflow menu. */
export function SubscriptionUsageMenuItems({
  provider,
  query,
}: {
  provider: Provider;
  query: ReturnType<typeof useSubscriptionUsage>;
}) {
  const t = useT();
  return (
    <>
      <DropdownMenuItem
        disabled={query.isFetching}
        onSelect={() => void query.refetch()}
      >
        <RefreshCw01 />
        {t("settings.subscriptionUsage.refresh")}
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <a
          href={PROVIDER_USAGE_URL[provider]}
          target="_blank"
          rel="noopener noreferrer"
        >
          <LinkExternal01 />
          {t("settings.subscriptionUsage.openProvider")}
        </a>
      </DropdownMenuItem>
    </>
  );
}
