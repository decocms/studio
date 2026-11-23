/**
 * Consolidation proposals for Plan goals: a quiet notice when open goals look
 * like the same goal, and a dialog that walks the member through each pair.
 * The AI proposes and a person decides: nothing merges without "Merge", and
 * the merged sentence is theirs to edit first.
 */

import { useState } from "react";
import { toast } from "sonner";
import {
  PLAN_GOAL_MAX_LENGTH,
  type PlanGoal,
} from "@decocms/shared/plan-goals";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@decocms/ui/components/dialog.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  usePlanGoalActions,
  usePlanGoalDuplicates,
  type PlanGoalPair,
} from "@/hooks/use-plan-goals";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";

/** "3 people", for how many work toward a goal. */
export function goalPeople(t: TFunction, n: number): string {
  if (n === 0) return t("plan.goals.similar.peopleNone");
  if (n === 1) return t("plan.goals.similar.peopleOne");
  return t("plan.goals.similar.peopleMany", { n });
}

function MergePair({
  pair,
  remaining,
  onMerged,
  onDismiss,
}: {
  pair: PlanGoalPair;
  remaining: number;
  onMerged: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const actions = usePlanGoalActions();
  const [statement, setStatement] = useState(pair.target.statement);
  const merged = statement.trim();
  const pending = actions.merge.isPending;

  const merge = () =>
    actions.merge.mutate(
      {
        source_id: pair.source.id,
        target_id: pair.target.id,
        statement: merged,
      },
      {
        onSuccess: () => {
          track("plan_goal_merged", {
            edited: merged !== pair.target.statement,
            users: pair.target.users + pair.source.users,
          });
          toast.success(t("plan.goals.duplicates.merged"));
          onMerged();
        },
        onError: (error) =>
          toast.error(
            error instanceof Error && error.message
              ? error.message
              : t("plan.goals.duplicates.mergeError"),
          ),
      },
    );

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("plan.goals.duplicates.title")}</DialogTitle>
        <DialogDescription>
          {t("plan.goals.duplicates.description")}
        </DialogDescription>
      </DialogHeader>
      <ul className="flex flex-col gap-2">
        {[pair.target, pair.source].map((goal: PlanGoal) => (
          <li
            key={goal.id}
            className="flex flex-col gap-1 rounded-lg border bg-muted/40 p-3"
          >
            <p className="text-sm text-foreground">{goal.statement}</p>
            <p className="text-meta">{goalPeople(t, goal.users)}</p>
          </li>
        ))}
      </ul>
      <label className="flex flex-col gap-1.5 text-sm font-medium text-foreground">
        {t("plan.goals.duplicates.statement")}
        <Textarea
          value={statement}
          maxLength={PLAN_GOAL_MAX_LENGTH}
          onChange={(event) => setStatement(event.target.value)}
          className="min-h-20 text-base font-normal"
        />
      </label>
      <DialogFooter className="items-center">
        {remaining > 1 && (
          <span className="text-meta sm:mr-auto">
            {t("plan.goals.duplicates.remaining", { n: remaining })}
          </span>
        )}
        <Button variant="outline" disabled={pending} onClick={onDismiss}>
          {t("plan.goals.duplicates.notSame")}
        </Button>
        <Button disabled={!merged || pending} onClick={merge}>
          {t("plan.goals.duplicates.merge")}
        </Button>
      </DialogFooter>
    </>
  );
}

export function PlanGoalDuplicates({ goals }: { goals: PlanGoal[] }) {
  const t = useT();
  const { pairs, dismiss } = usePlanGoalDuplicates(goals);
  const [open, setOpen] = useState(false);
  /** Goals merged away here, hidden before the list catches up. */
  const [gone, setGone] = useState<string[]>([]);
  const visible = pairs.filter(
    (pair) => !gone.includes(pair.source.id) && !gone.includes(pair.target.id),
  );
  const current = visible[0];
  if (!current) return null;
  const count = new Set(
    visible.flatMap((pair) => [pair.source.id, pair.target.id]),
  ).size;

  return (
    <>
      <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
        {t("plan.goals.duplicates.notice", { n: count })}
        <Button
          variant="link"
          size="sm"
          className="h-auto px-0 underline"
          onClick={() => {
            track("plan_goal_duplicates_opened", { pairs: visible.length });
            setOpen(true);
          }}
        >
          {t("plan.goals.duplicates.review")}
        </Button>
      </p>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <MergePair
            key={current.key}
            pair={current}
            remaining={visible.length}
            onMerged={() => {
              setGone((prev) => [...prev, current.source.id]);
              if (visible.length === 1) setOpen(false);
            }}
            onDismiss={() => {
              track("plan_goal_merge_dismissed");
              dismiss(current.key);
              if (visible.length === 1) setOpen(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}
