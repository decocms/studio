/**
 * The store goal at the top of Plan: one sentence a member writes, shown big,
 * edited in place. It travels with every business case the page asks for.
 */

import { useState, type FormEvent } from "react";
import { Edit03, Target04 } from "@untitledui/icons";
import { toast } from "sonner";
import { PLAN_OBJECTIVE_MAX_LENGTH } from "@decocms/shared/organization/schema";
import { Button } from "@decocms/ui/components/button.tsx";
import { Textarea } from "@decocms/ui/components/textarea.tsx";
import {
  usePlanObjective,
  useSetPlanObjective,
} from "@/hooks/use-organization-settings";
import { useT } from "@/i18n/use-t.ts";

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
    save.mutate(value, {
      onSuccess: onDone,
      onError: () => toast.error(t("plan.objective.saveError")),
    });

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
  const [editing, setEditing] = useState(false);
  const statement = objective?.statement ?? "";

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
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Edit03 />
            {t("plan.objective.edit")}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3">
          <p className="max-w-[560px] text-base text-pretty text-muted-foreground">
            {t("plan.objective.empty")}
          </p>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            {t("plan.objective.write")}
          </Button>
        </div>
      )}
    </section>
  );
}
