/** The store goal at the top of Plan: a member writes it, and may ask the AI to find it in what the brand wrote and said. The form is shared with Plan goals. */

import { useRef, useState, type FormEvent } from "react";
import { Edit03, Stars02, StopCircle, Target04 } from "@untitledui/icons";
import { toast } from "sonner";
import { PLAN_OBJECTIVE_MAX_LENGTH } from "@decocms/shared/organization/schema";
import type { PlanGoalSource } from "@decocms/shared/plan-goals";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@decocms/ui/components/alert-dialog.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  useFindPlanObjective,
  usePlanObjective,
  useSetPlanObjective,
} from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";
import { track } from "@/lib/posthog-client";
import { type FindNotice, findFills, findNotice } from "./find-store-goal.ts";
import { goalSource, keptSource } from "./suggest-goals.ts";

function FindNoticeText({
  notice,
  draft,
  suggestion,
}: {
  notice: FindNotice;
  draft: string;
  /** The person had written their own goal: the finding waits beside it. */
  suggestion?: { onUse: () => void; onKeep: () => void };
}) {
  const t = useT();
  if (notice.kind === "found") {
    const found = t("plan.objective.found", {
      source: notice.source,
      quote: notice.quote,
    });
    if (suggestion) {
      return (
        <div className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
          <p className="text-meta">{found}</p>
          <p className="text-sm text-foreground">{notice.statement}</p>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={suggestion.onUse}
            >
              {t("plan.objective.useFound")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={suggestion.onKeep}
            >
              {t("plan.objective.keepMine")}
            </Button>
          </div>
        </div>
      );
    }
    // The source stays while the person edits the sentence it came from.
    if (!draft) return null;
    return <p className="text-meta">{found}</p>;
  }
  return <FindMissing notice={notice} />;
}

/** Why the AI found nothing, what it read and what it could not, and how to give it more. */
export function FindMissing({
  notice,
}: {
  notice: Extract<FindNotice, { kind: "missing" }>;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1 text-sm text-muted-foreground">
      <p className="text-foreground">{t(notice.message)}</p>
      <p>
        {notice.read.length > 0
          ? t("plan.objective.read", { sources: notice.read.join(", ") })
          : t("plan.objective.readNothing")}
      </p>
      {notice.unread.length > 0 && (
        <p>{t("plan.objective.unread", { files: notice.unread.join(", ") })}</p>
      )}
      <p>{t("plan.objective.connectHint")}</p>
    </div>
  );
}

/** Where the sentence in the input came from, while it is still the one the AI found. */
function sourceOf(
  notice: FindNotice | null,
  statement: string,
): PlanGoalSource | null {
  if (notice?.kind !== "found" || notice.statement.trim() !== statement) {
    return null;
  }
  return goalSource(notice.source, notice.quote);
}

/** The goal is the organization's, so clearing it asks first. */
function ClearGoal({
  disabled,
  onClear,
}: {
  disabled: boolean;
  onClear: () => void;
}) {
  const t = useT();
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          type="button"
          variant="ghost-destructive"
          size="sm"
          disabled={disabled}
        >
          {t("plan.objective.clear")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("plan.objective.clearConfirm.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("plan.objective.clearConfirm.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("plan.objective.cancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onClear}>
            {t("plan.objective.clearConfirm.action")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ObjectiveForm({
  initial,
  onDone,
  saving,
  onSave,
  onClear,
  source = null,
  onSuggest,
}: {
  initial: string;
  /** Leaves the form; absent while no goal is saved, so the form is the page. */
  onDone?: () => void;
  saving: boolean;
  /** Writes the sentence; `source` is set while it is still what the AI found. */
  onSave: (statement: string, source: PlanGoalSource | null) => void;
  /** Offers to clear the goal; absent when there is nothing to clear. */
  onClear?: () => void;
  /** Where the AI found `initial`; kept while the sentence is unchanged. */
  source?: PlanGoalSource | null;
  /** With Plan goals the AI button opens the suggested goals instead of
   *  looking for one goal here; null hides it. */
  onSuggest?: (() => void) | null;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  /** The draft as it is now, for a search that answers after an edit. */
  const latest = useRef(initial);
  const [notice, setNotice] = useState<FindNotice | null>(null);
  /** The finding is waiting beside the person's own goal. */
  const [suggested, setSuggested] = useState(false);
  /** Only the latest search may answer; Stop moves this on. */
  const lookups = useRef(0);
  const find = useFindPlanObjective();
  const statement = draft.trim();
  const busy = saving || find.isPending;
  const kept = keptSource(source, initial, statement);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (statement) onSave(statement, sourceOf(notice, statement) ?? kept);
  };

  const edit = (value: string) => {
    latest.current = value;
    setDraft(value);
  };

  const lookUp = () => {
    track("plan_objective_find_clicked");
    const lookup = ++lookups.current;
    setNotice(null);
    setSuggested(false);
    find.mutate(undefined, {
      onSuccess: (result) => {
        if (lookup !== lookups.current) return;
        const next = findNotice(result);
        // Decided on the draft as it is now: the input stays open meanwhile.
        const fills =
          next.kind === "found" && findFills(latest.current, initial);
        track("plan_objective_find_answered", {
          outcome: result.found ? "found" : (result.reason ?? "not_found"),
          ...(next.kind === "found"
            ? { applied: fills ? "filled" : "suggested" }
            : {}),
        });
        if (next.kind === "found") {
          if (fills) edit(next.statement);
          setSuggested(!fills);
        }
        setNotice(next);
      },
      onError: () => {
        if (lookup !== lookups.current) return;
        setNotice({
          kind: "missing",
          message: "plan.objective.findUnavailable",
          read: [],
          unread: [],
        });
      },
    });
  };

  const stop = () => {
    track("plan_objective_find_stopped");
    lookups.current++;
    find.reset();
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Textarea
        aria-label={t("plan.objective.label")}
        placeholder={t("plan.objective.placeholder")}
        value={draft}
        maxLength={PLAN_OBJECTIVE_MAX_LENGTH}
        onChange={(event) => edit(event.target.value)}
        className="min-h-20 text-base"
        autoFocus={onDone !== undefined}
      />
      {find.isPending ? (
        <p className="animate-pulse text-sm text-muted-foreground">
          {t("plan.objective.finding")}
        </p>
      ) : notice ? (
        <FindNoticeText
          notice={notice}
          draft={statement}
          suggestion={
            suggested && notice.kind === "found"
              ? {
                  onUse: () => {
                    edit(notice.statement);
                    setSuggested(false);
                  },
                  onKeep: () => {
                    setNotice(null);
                    setSuggested(false);
                  },
                }
              : undefined
          }
        />
      ) : kept ? (
        <p className="text-meta">
          {t("plan.goals.suggest.found", {
            source: kept.label,
            quote: kept.quote,
          })}
        </p>
      ) : (
        <span className="text-meta">{t("plan.objective.hint")}</span>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {onSuggest === null ? null : onSuggest ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={saving}
            onClick={onSuggest}
          >
            <Stars02 />
            {t("plan.goals.suggest.action")}
          </Button>
        ) : find.isPending ? (
          <Button type="button" variant="outline" size="sm" onClick={stop}>
            <StopCircle />
            {t("plan.objective.stop")}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={lookUp}
          >
            <Stars02 />
            {t("plan.objective.find")}
          </Button>
        )}
        {onClear && <ClearGoal disabled={busy} onClear={onClear} />}
        <div className="ml-auto flex gap-2">
          {onDone && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={onDone}
            >
              {t("plan.objective.cancel")}
            </Button>
          )}
          <Button type="submit" size="sm" disabled={!statement || busy}>
            {t("plan.objective.save")}
          </Button>
        </div>
      </div>
    </form>
  );
}

/** The single store goal's form: writes `plan_objective`, and clears it. */
function StoreGoalForm({
  initial,
  onDone,
}: {
  initial: string;
  onDone?: () => void;
}) {
  const t = useT();
  const save = useSetPlanObjective();
  const write = (value: string | null) =>
    save.mutate(
      { statement: value },
      {
        onSuccess: () => onDone?.(),
        onError: () => toast.error(t("plan.objective.saveError")),
      },
    );
  return (
    <ObjectiveForm
      initial={initial}
      onDone={onDone}
      saving={save.isPending}
      onSave={(statement) => write(statement)}
      onClear={initial ? () => write(null) : undefined}
    />
  );
}

export function PlanObjective() {
  const t = useT();
  const objective = usePlanObjective();
  const [editing, setEditing] = useState(false);
  const statement = objective?.statement ?? "";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
        <Target04 size={13} />
        {t("plan.objective.eyebrow")}
      </div>
      {!statement ? (
        <>
          <p className="max-w-[560px] text-base text-pretty text-muted-foreground">
            {t("plan.objective.empty")}
          </p>
          <StoreGoalForm initial="" />
        </>
      ) : editing ? (
        <StoreGoalForm initial={statement} onDone={() => setEditing(false)} />
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="max-w-[720px] text-2xl leading-snug font-medium text-balance text-foreground">
            {statement}
          </p>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Edit03 />
            {t("plan.objective.edit")}
          </Button>
        </div>
      )}
    </section>
  );
}
