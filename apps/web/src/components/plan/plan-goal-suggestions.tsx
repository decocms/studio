/**
 * Suggest goals with AI: the AI reads what the brand wrote and said and
 * proposes goals the organization does not have yet. The member adds, edits
 * or dismisses each one, and nothing is saved until they add it. The list
 * sits apart from the goal form, so a suggestion never replaces what the
 * person typed there.
 */

import { useRef, useState } from "react";
import { Edit03, Plus, Stars02, StopCircle, XClose } from "@untitledui/icons";
import { toast } from "sonner";
import type { PlanGoalSource } from "@decocms/shared/plan-goals";
import { Button } from "@decocms/ui/components/button.tsx";
import {
  usePlanGoalActions,
  useSuggestPlanGoals,
} from "@/hooks/use-plan-goals";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import type { FindNotice } from "./find-store-goal.ts";
import { FindMissing, ObjectiveForm } from "./plan-objective.tsx";
import {
  type GoalSuggestion,
  goalSource,
  suggestionsNotice,
} from "./suggest-goals.ts";

type MissingNotice = Extract<FindNotice, { kind: "missing" }>;

export interface GoalSuggestionsState {
  /** Whether the list shows: looking, found nothing, or goals left to review. */
  visible: boolean;
  pending: boolean;
  candidates: GoalSuggestion[];
  notice: MissingNotice | null;
  start: (from: "picker" | "form") => void;
  stop: () => void;
  close: () => void;
  remove: (candidate: GoalSuggestion) => void;
  /** Whether the goal being added also becomes the member's goal: only the
   *  first one added, and only for a member with no goal yet. */
  claimActive: (hasGoal: boolean) => boolean;
  releaseActive: () => void;
}

export function useGoalSuggestions(): GoalSuggestionsState {
  const suggest = useSuggestPlanGoals();
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<GoalSuggestion[]>([]);
  const [notice, setNotice] = useState<MissingNotice | null>(null);
  /** Only the latest search may answer; Stop and Close move this on. */
  const lookups = useRef(0);
  const claimed = useRef(false);

  const forget = () => {
    lookups.current++;
    suggest.reset();
    setOpen(false);
    setCandidates([]);
    setNotice(null);
  };

  return {
    visible:
      open && (suggest.isPending || notice !== null || candidates.length > 0),
    pending: suggest.isPending,
    candidates,
    notice,
    start: (from) => {
      track("plan_goal_suggest_clicked", { from });
      const lookup = ++lookups.current;
      claimed.current = false;
      setOpen(true);
      setCandidates([]);
      setNotice(null);
      suggest.mutate(undefined, {
        onSuccess: (result) => {
          if (lookup !== lookups.current) return;
          track("plan_goal_suggest_answered", {
            outcome:
              result.candidates.length > 0
                ? "found"
                : (result.reason ?? "not_found"),
            count: result.candidates.length,
          });
          setCandidates(result.candidates);
          setNotice(suggestionsNotice(result));
        },
        onError: () => {
          if (lookup !== lookups.current) return;
          track("plan_goal_suggest_answered", { outcome: "error", count: 0 });
          setNotice({
            kind: "missing",
            message: "plan.objective.findUnavailable",
            read: [],
            unread: [],
          });
        },
      });
    },
    stop: () => {
      track("plan_goal_suggest_stopped");
      forget();
    },
    close: forget,
    remove: (candidate) =>
      setCandidates((left) => left.filter((other) => other !== candidate)),
    claimActive: (hasGoal) => {
      if (hasGoal || claimed.current) return false;
      claimed.current = true;
      return true;
    },
    releaseActive: () => {
      claimed.current = false;
    },
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function SuggestionCard({
  candidate,
  position,
  hasGoal,
  suggestions,
}: {
  candidate: GoalSuggestion;
  position: number;
  hasGoal: boolean;
  suggestions: GoalSuggestionsState;
}) {
  const t = useT();
  const { create } = usePlanGoalActions();
  const [editing, setEditing] = useState(false);
  const source = goalSource(candidate.source.label, candidate.quote);

  const add = (statement: string, kept: PlanGoalSource | null) => {
    const makeActive = suggestions.claimActive(hasGoal);
    create.mutate(
      { statement, source: kept, make_active: makeActive },
      {
        onSuccess: () => {
          track("plan_goal_suggestion_added", {
            position,
            edited: statement !== candidate.statement,
            made_active: makeActive,
          });
          suggestions.remove(candidate);
        },
        onError: (error) => {
          if (makeActive) suggestions.releaseActive();
          toast.error(errorText(error, t("plan.goals.saveError")));
        },
      },
    );
  };

  if (editing) {
    return (
      <li className="rounded-lg border bg-background p-3">
        <ObjectiveForm
          initial={candidate.statement}
          source={source}
          onSuggest={null}
          onDone={() => setEditing(false)}
          saving={create.isPending}
          onSave={add}
        />
      </li>
    );
  }
  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-background p-3">
      <p className="text-base text-pretty text-foreground">
        {candidate.statement}
      </p>
      <p className="text-meta">
        {t("plan.goals.suggest.found", {
          source: candidate.source.label,
          quote: candidate.quote,
        })}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={create.isPending}
          onClick={() => add(candidate.statement, source)}
        >
          <Plus />
          {t("plan.goals.suggest.add")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={create.isPending}
          onClick={() => setEditing(true)}
        >
          <Edit03 />
          {t("plan.goals.suggest.edit")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={create.isPending}
          onClick={() => {
            track("plan_goal_suggestion_dismissed", { position });
            suggestions.remove(candidate);
          }}
        >
          <XClose />
          {t("plan.goals.suggest.dismiss")}
        </Button>
      </div>
    </li>
  );
}

export function GoalSuggestions({
  suggestions,
  hasGoal,
}: {
  suggestions: GoalSuggestionsState;
  /** Whether the member already works toward a goal. */
  hasGoal: boolean;
}) {
  const t = useT();
  if (!suggestions.visible) return null;
  if (suggestions.pending) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 p-4">
        <Stars02 className="size-4 text-muted-foreground" />
        <p className="flex-1 animate-pulse text-sm text-muted-foreground">
          {t("plan.goals.suggest.finding")}
        </p>
        <Button variant="outline" size="sm" onClick={suggestions.stop}>
          <StopCircle />
          {t("plan.objective.stop")}
        </Button>
      </div>
    );
  }
  const close = (
    <Button
      variant="ghost"
      size="sm"
      className="self-start"
      onClick={suggestions.close}
    >
      {t("plan.goals.suggest.close")}
    </Button>
  );
  if (suggestions.notice) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-4">
        <FindMissing notice={suggestions.notice} />
        {close}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-4">
      <div className="flex flex-col gap-1">
        <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <Stars02 className="size-4" />
          {t("plan.goals.suggest.heading")}
        </p>
        <p className="text-sm text-muted-foreground">
          {t("plan.goals.suggest.description")}
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {suggestions.candidates.map((candidate, index) => (
          <SuggestionCard
            key={candidate.statement}
            candidate={candidate}
            position={index}
            hasGoal={hasGoal}
            suggestions={suggestions}
          />
        ))}
      </ul>
      {close}
    </div>
  );
}
