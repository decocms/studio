import { Target04 } from "@untitledui/icons";
import type { CampaignGoalMetric } from "@decocms/shared/blog-campaign";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";
import type { CampaignGoal } from "./blog-data";

/** What each goal metric reads as, lower case so it can follow a target. */
export const GOAL_METRIC_LABEL: Record<CampaignGoalMetric, TranslationKey> = {
  organic_sessions: "sandbox.campaigns.goalMetricOrganicSessions",
  sessions: "sandbox.campaigns.goalMetricSessions",
  search_clicks: "sandbox.campaigns.goalMetricSearchClicks",
  search_impressions: "sandbox.campaigns.goalMetricSearchImpressions",
  conversions: "sandbox.campaigns.goalMetricConversions",
  revenue: "sandbox.campaigns.goalMetricRevenue",
};

/** The text is what makes a goal: a target with nothing to aim it at is not one. */
export function hasGoal(goal: CampaignGoal): boolean {
  return goal.text.trim() !== "";
}

/** "+20% organic sessions": how far and what counts it, or "" with neither. */
export function goalMeasure(goal: CampaignGoal, t: TFunction): string {
  return [
    goal.target.trim(),
    goal.metric ? t(GOAL_METRIC_LABEL[goal.metric]) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** The goal on one line, where a campaign is listed; nothing when it has none. */
export function GoalLine({
  goal,
  className,
}: {
  goal: CampaignGoal;
  className?: string;
}) {
  const t = useT();
  if (!hasGoal(goal)) return null;
  const measure = goalMeasure(goal, t);
  return (
    <p
      className={cn(
        "flex items-start gap-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      <Target04 size={12} className="mt-0.5 shrink-0 text-success" />
      <span className="line-clamp-2 min-w-0">
        {t("sandbox.campaigns.goalLine", { goal: goal.text.trim() })}
        {measure && (
          <span className="font-medium text-foreground"> · {measure}</span>
        )}
      </span>
    </p>
  );
}
