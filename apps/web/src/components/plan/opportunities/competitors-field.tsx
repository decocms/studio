/**
 * The stores the analysis compares the store with. The engine suggests a
 * list on the first run and checks every domain a member saves; a saved
 * list is confirmed and the engine no longer replaces it.
 */

import { useId, useState } from "react";
import { Edit03, XClose } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Input } from "@decocms/ui/components/input.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { useT } from "@/i18n/use-t.ts";
import type { CompetitorRejection } from "./diagnosis-schema.ts";
import { DiagnosisEngineError } from "./diagnosis-state.ts";
import { addDomain, canSave, cleanList } from "./competitors-field.ts";
import { errorText } from "./opportunity-view.ts";
import { useCanEditSetup } from "./store-domain.tsx";
import {
  useCompetitorWarnings,
  useUpdateCompetitors,
} from "./use-plan-diagnosis.ts";

/** The domains the engine could not reach; nothing was saved. */
function rejectionsOf(error: Error | null): CompetitorRejection[] {
  return error instanceof DiagnosisEngineError ? error.rejected : [];
}

function CompetitorsForm({
  initial,
  onSaved,
  onCancel,
}: {
  initial: string[];
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const t = useT();
  const inputId = useId();
  const update = useUpdateCompetitors();
  const [list, setList] = useState(() => cleanList(initial));
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<"invalid" | "duplicate" | null>(
    null,
  );
  const rejected = rejectionsOf(update.error);
  const failure =
    update.isError && rejected.length === 0
      ? (errorText(update.error) ?? t("plan.opportunities.competitors.failed"))
      : null;

  const add = () => {
    const next = addDomain(list, draft);
    setDraftError(next.error);
    if (next.error) return;
    setList(next.list);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-2">
      {list.length > 0 && (
        <ul className="flex flex-wrap items-start gap-2">
          {list.map((domain) => {
            const reason = rejected.find((r) => r.domain === domain)?.reason;
            return (
              <li key={domain} className="flex max-w-full flex-col gap-0.5">
                <Badge
                  variant={reason ? "destructive" : "muted"}
                  size="lg"
                  className="gap-1 pr-1"
                >
                  <span className="truncate">{domain}</span>
                  <button
                    type="button"
                    className="rounded-full p-0.5 hover:bg-secondary-hover focus-ring"
                    aria-label={t("plan.opportunities.competitors.remove", {
                      domain,
                    })}
                    onClick={() =>
                      setList((current) => current.filter((d) => d !== domain))
                    }
                  >
                    <XClose size={12} />
                  </button>
                </Badge>
                {reason && (
                  <span role="alert" className="text-xs text-destructive">
                    {reason}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <label htmlFor={inputId} className="text-xs text-muted-foreground">
          {t("plan.opportunities.competitors.label")}
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            inputMode="url"
            autoComplete="off"
            placeholder={t("plan.opportunities.competitors.placeholder")}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setDraftError(null);
            }}
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            className="shrink-0"
            disabled={!draft.trim()}
          >
            {t("plan.opportunities.competitors.add")}
          </Button>
        </div>
        {draftError && (
          <p role="alert" className="text-xs text-destructive">
            {draftError === "invalid"
              ? t("plan.opportunities.competitors.invalid")
              : t("plan.opportunities.competitors.duplicate")}
          </p>
        )}
      </form>
      {failure && (
        <p role="alert" className="break-words text-xs text-destructive">
          {failure}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!canSave(list) || update.isPending}
          onClick={() => update.mutate(list, { onSuccess: () => onSaved?.() })}
        >
          {update.isPending && <Spinner size="2xs" />}
          {t("plan.opportunities.competitors.save")}
        </Button>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t("plan.opportunities.competitors.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The competitors the last save kept but could not check. */
function WarningsNote() {
  const t = useT();
  const warnings = useCompetitorWarnings();
  if (warnings.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {warnings.map((w) => (
        <li key={w.domain}>
          {`${w.domain}: ${t("plan.opportunities.competitors.blocksBots")}`}
        </li>
      ))}
    </ul>
  );
}

/** "Compared with: a, b · Edit". A `suggested` list is the engine's until
 *  a member confirms it as it is or edits it; with none, the form opens. */
export function CompetitorsRow({
  list,
  suggested = false,
}: {
  list: string[];
  suggested?: boolean;
}) {
  const t = useT();
  const canEdit = useCanEditSetup();
  const confirm = useUpdateCompetitors();
  const [editing, setEditing] = useState(false);

  if (editing || (suggested && list.length === 0)) {
    return (
      <div className="flex max-w-md flex-col gap-2">
        <CompetitorsForm
          initial={list}
          onSaved={() => setEditing(false)}
          onCancel={list.length > 0 ? () => setEditing(false) : undefined}
        />
        <WarningsNote />
      </div>
    );
  }

  const names = list.join(", ");
  const confirmed = cleanList(list);
  const rejected = rejectionsOf(confirm.error);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <span className="min-w-0 break-words">
          {suggested
            ? t("plan.opportunities.competitors.suggested", { list: names })
            : t("plan.opportunities.competitors.current", { list: names })}
        </span>
        {canEdit && suggested && (
          <Button
            size="sm"
            className="h-7 px-2"
            disabled={!canSave(confirmed) || confirm.isPending}
            onClick={() => confirm.mutate(confirmed)}
          >
            {confirm.isPending && <Spinner size="2xs" />}
            {t("plan.opportunities.competitors.confirm")}
          </Button>
        )}
        {canEdit && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={() => setEditing(true)}
          >
            <Edit03 />
            {t("plan.opportunities.competitors.edit")}
          </Button>
        )}
      </div>
      {confirm.isError && (
        <ul
          role="alert"
          className="flex flex-col gap-0.5 break-words text-xs text-destructive"
        >
          {rejected.length > 0 ? (
            rejected.map((r) => (
              <li key={r.domain}>{`${r.domain}: ${r.reason}`}</li>
            ))
          ) : (
            <li>
              {errorText(confirm.error) ??
                t("plan.opportunities.competitors.failed")}
            </li>
          )}
        </ul>
      )}
      <WarningsNote />
    </div>
  );
}
