/** The store goal at the top of Plan: a member writes it, and may ask the AI to find it in what the brand wrote and said. */

import { useState, type FormEvent } from "react";
import { Edit03, Stars02, Target04 } from "@untitledui/icons";
import { toast } from "sonner";
import { PLAN_OBJECTIVE_MAX_LENGTH } from "@decocms/shared/organization/schema";
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
import { type FindNotice, findNotice } from "./find-store-goal.ts";

function FindNoticeText({
  notice,
  draft,
}: {
  notice: FindNotice;
  draft: string;
}) {
  const t = useT();
  if (notice.kind === "found") {
    // The source stays while the person edits the sentence it came from.
    if (!draft) return null;
    return (
      <p className="text-meta">
        {t("plan.objective.found", {
          source: notice.source,
          quote: notice.quote,
        })}
      </p>
    );
  }
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

function ObjectiveForm({
  initial,
  onDone,
}: {
  initial: string;
  /** Leaves the form; absent while no goal is saved, so the form is the page. */
  onDone?: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const [notice, setNotice] = useState<FindNotice | null>(null);
  const save = useSetPlanObjective();
  const find = useFindPlanObjective();
  const statement = draft.trim();
  const busy = save.isPending || find.isPending;

  const write = (value: string | null) =>
    save.mutate(
      { statement: value },
      {
        onSuccess: () => onDone?.(),
        onError: () => toast.error(t("plan.objective.saveError")),
      },
    );

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (statement) write(statement);
  };

  const lookUp = () => {
    track("plan_objective_find_clicked");
    setNotice(null);
    find.mutate(undefined, {
      onSuccess: (result) => {
        const next = findNotice(result);
        track("plan_objective_find_answered", {
          outcome: result.found ? "found" : (result.reason ?? "not_found"),
        });
        if (next.kind === "found") setDraft(next.statement);
        setNotice(next);
      },
      onError: () =>
        setNotice({
          kind: "missing",
          message: "plan.objective.findUnavailable",
          read: [],
          unread: [],
        }),
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <Textarea
        aria-label={t("plan.objective.label")}
        placeholder={t("plan.objective.placeholder")}
        value={draft}
        maxLength={PLAN_OBJECTIVE_MAX_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        disabled={find.isPending}
        className="min-h-20 text-base"
        autoFocus={onDone !== undefined}
      />
      {find.isPending ? (
        <p className="animate-pulse text-sm text-muted-foreground">
          {t("plan.objective.finding")}
        </p>
      ) : notice ? (
        <FindNoticeText notice={notice} draft={statement} />
      ) : (
        <span className="text-meta">{t("plan.objective.hint")}</span>
      )}
      <div className="flex flex-wrap items-center gap-2">
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
        {initial && <ClearGoal disabled={busy} onClear={() => write(null)} />}
        <div className="ml-auto flex gap-2">
          {onDone && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={save.isPending}
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
          <ObjectiveForm initial="" />
        </>
      ) : editing ? (
        <ObjectiveForm initial={statement} onDone={() => setEditing(false)} />
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
