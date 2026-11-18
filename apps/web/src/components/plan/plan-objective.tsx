/** The store goal at the top of Plan; Jev picks it while empty, a member edits it or asks Jev to review it. */

import { useState, type FormEvent } from "react";
import { Edit03, RefreshCw01, Stars02, Target04 } from "@untitledui/icons";
import { toast } from "sonner";
import {
  PLAN_OBJECTIVE_MAX_LENGTH,
  type PlanGoal,
} from "@decocms/shared/organization/schema";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import { useChatTask } from "@/components/chat";
import {
  useAutoPlanObjective,
  useDecidePlanObjective,
  usePlanObjective,
  useSetPlanObjective,
} from "@/hooks/use-organization-settings";
import type { TranslationKey } from "@/i18n/en/index.ts";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { type NoGoalReason, reviewStoreGoal } from "./review-store-goal.ts";

const GOAL_TEXT: Record<PlanGoal, TranslationKey> = {
  mobile_conversion: "plan.goal.mobile_conversion",
  checkout_completion: "plan.goal.checkout_completion",
  cart_to_checkout: "plan.goal.cart_to_checkout",
  product_to_cart: "plan.goal.product_to_cart",
  traffic_growth: "plan.goal.traffic_growth",
  recover_sales: "plan.goal.recover_sales",
  average_ticket: "plan.goal.average_ticket",
  site_stability: "plan.goal.site_stability",
};

const NO_GOAL_TEXT: Record<NoGoalReason, TranslationKey> = {
  no_data: "plan.objective.review.noData",
  unavailable: "plan.objective.review.unavailable",
  uncertain: "plan.objective.review.uncertain",
};

function ObjectiveForm({
  initial,
  onDone,
}: {
  initial: string;
  onDone: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const save = useSetPlanObjective();
  const statement = draft.trim();

  const write = (value: string | null) =>
    save.mutate(
      { statement: value },
      {
        onSuccess: onDone,
        onError: () => toast.error(t("plan.objective.saveError")),
      },
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (statement) write(statement);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Textarea
        aria-label={t("plan.objective.label")}
        placeholder={t("plan.objective.placeholder")}
        value={draft}
        maxLength={PLAN_OBJECTIVE_MAX_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        className="min-h-20 text-base"
        autoFocus
      />
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-meta">{t("plan.objective.hint")}</span>
        <div className="ml-auto flex gap-2">
          {initial && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => write(null)}
            >
              {t("plan.objective.clear")}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={save.isPending}
            onClick={onDone}
          >
            {t("plan.objective.cancel")}
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={!statement || save.isPending}
          >
            {t("plan.objective.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function PlanObjective() {
  const t = useT();
  const objective = usePlanObjective();
  const { createTaskWithMessage } = useChatTask();
  const [editing, setEditing] = useState(false);
  const statement = objective?.statement ?? "";
  const word = (goal: PlanGoal) => t(GOAL_TEXT[goal]);
  const auto = useAutoPlanObjective(word);
  const decide = useDecidePlanObjective();
  const save = useSetPlanObjective();
  const reviewing = decide.isPending || save.isPending;

  const review = () => {
    track("plan_objective_review_clicked");
    decide.mutate(undefined, {
      onError: () => toast.error(t(NO_GOAL_TEXT.unavailable)),
      onSuccess: (result) => {
        const outcome = reviewStoreGoal(objective, result);
        if (outcome.kind === "none") {
          toast(t(NO_GOAL_TEXT[outcome.reason]));
          return;
        }
        if (outcome.kind === "same") {
          toast(t("plan.objective.review.same"));
          return;
        }
        save.mutate(
          { statement: word(outcome.goal), source: "jev", goal: outcome.goal },
          {
            onSuccess: () => toast.success(t("plan.objective.review.updated")),
            onError: () => toast.error(t("plan.objective.saveError")),
          },
        );
      },
    });
  };

  // The agent proposes the goal in a chat and saves it only once approved.
  const suggest = () => {
    track("plan_objective_suggest_clicked");
    createTaskWithMessage({
      message: {
        parts: [
          {
            type: "text",
            text: t("plan.prompt.suggestObjective", {
              max: PLAN_OBJECTIVE_MAX_LENGTH,
            }),
          },
        ],
      },
    });
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Target04 size={13} />
        {t("plan.objective.eyebrow")}
      </div>
      {editing ? (
        <ObjectiveForm initial={statement} onDone={() => setEditing(false)} />
      ) : statement ? (
        <div className="flex flex-col items-start gap-3">
          <p className="max-w-[720px] text-2xl leading-snug font-medium text-balance text-foreground">
            {statement}
          </p>
          {objective?.source === "jev" && (
            <p className="text-meta">{t("plan.objective.pickedByAi")}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              <Edit03 />
              {t("plan.objective.edit")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={reviewing}
              onClick={review}
            >
              <RefreshCw01 />
              {reviewing
                ? t("plan.objective.reviewing")
                : t("plan.objective.review")}
            </Button>
          </div>
        </div>
      ) : auto.isFetching ? (
        <p className="max-w-[560px] animate-pulse text-base text-muted-foreground">
          {t("plan.objective.deciding")}
        </p>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="max-w-[560px] text-base text-pretty text-muted-foreground">
            {t("plan.objective.empty")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={suggest}>
              <Stars02 />
              {t("plan.objective.suggest")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(true)}
            >
              {t("plan.objective.write")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
