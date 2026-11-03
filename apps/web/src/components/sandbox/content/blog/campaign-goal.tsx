import { useState } from "react";
import { Target04, Trash01 } from "@untitledui/icons";
import {
  CAMPAIGN_GOAL_METRICS,
  type CampaignGoalMetric,
} from "@decocms/shared/blog-campaign";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Label } from "@decocms/ui/components/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@decocms/ui/components/select.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { useT } from "@/i18n/use-t.ts";
import type { TFunction, TranslationKey } from "@/i18n/use-t.ts";
import type { CampaignGoal } from "./blog-data";

/** What each goal metric reads as, lower case so it can follow a target. */
const GOAL_METRIC_LABEL: Record<CampaignGoalMetric, TranslationKey> = {
  organic_sessions: "sandbox.campaigns.goalMetricOrganicSessions",
  sessions: "sandbox.campaigns.goalMetricSessions",
  search_clicks: "sandbox.campaigns.goalMetricSearchClicks",
  search_impressions: "sandbox.campaigns.goalMetricSearchImpressions",
  conversions: "sandbox.campaigns.goalMetricConversions",
  revenue: "sandbox.campaigns.goalMetricRevenue",
};

/** "+20% organic sessions": how far and what counts it, or "" with neither. */
export function goalMeasure(goal: CampaignGoal, t: TFunction): string {
  return [
    goal.target.trim(),
    goal.metric ? t(GOAL_METRIC_LABEL[goal.metric]) : "",
  ]
    .filter(Boolean)
    .join(" ");
}

/** A campaign's goals on one line, where it is listed: the first, and how many more. */
export function GoalLine({
  goals,
  className,
}: {
  goals: readonly CampaignGoal[];
  className?: string;
}) {
  const t = useT();
  const [goal, ...more] = goals;
  if (!goal) return null;
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
        {more.length > 0 && <span> · +{more.length}</span>}
      </span>
    </p>
  );
}

/**
 * One of a campaign's goals, set by a person; `goal` null adds one. Mounted
 * only while open, so it starts from the goal it is given.
 */
export function GoalDialog({
  goal,
  pending,
  onSave,
  onDelete,
  onClose,
}: {
  goal: CampaignGoal | null;
  pending: boolean;
  onSave: (goal: CampaignGoal) => void;
  /** Present for a goal the campaign already has. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const [text, setText] = useState(goal?.text ?? "");
  const [metric, setMetric] = useState<CampaignGoalMetric | null>(
    goal?.metric ?? null,
  );
  const [target, setTarget] = useState(goal?.target ?? "");
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sandbox.campaigns.goalLabel")}</DialogTitle>
          <DialogDescription>
            {t("contentTrack.campaign.goalHint")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="campaign-goal-text">
              {t("sandbox.campaigns.goalLabel")}
            </Label>
            <Input
              id="campaign-goal-text"
              value={text}
              maxLength={200}
              placeholder={t("contentTrack.campaign.goalPlaceholder")}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="campaign-goal-target">
                {t("sandbox.campaigns.goalTargetLabel")}
              </Label>
              <Input
                id="campaign-goal-target"
                value={target}
                maxLength={40}
                placeholder="+20%"
                onChange={(e) => setTarget(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>{t("sandbox.campaigns.goalMetricLabel")}</Label>
              <Select
                value={metric ?? "none"}
                onValueChange={(value) =>
                  setMetric(
                    CAMPAIGN_GOAL_METRICS.find((entry) => entry === value) ??
                      null,
                  )
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {t("sandbox.campaigns.goalMetricNone")}
                  </SelectItem>
                  {CAMPAIGN_GOAL_METRICS.map((entry) => (
                    <SelectItem key={entry} value={entry}>
                      {t(GOAL_METRIC_LABEL[entry])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <DialogFooter>
          {onDelete && (
            <Button
              variant="ghost"
              className="mr-auto text-destructive"
              disabled={pending}
              onClick={onDelete}
            >
              <Trash01 size={14} />
              {t("contentTrack.campaign.deleteGoal")}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            {t("contentTrack.new.cancel")}
          </Button>
          <Button
            disabled={pending || text.trim() === ""}
            onClick={() =>
              onSave({ text: text.trim(), metric, target: target.trim() })
            }
          >
            {t("contentTrack.campaign.saveGoal")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
