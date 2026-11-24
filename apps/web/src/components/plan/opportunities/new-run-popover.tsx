/**
 * "Nova análise": the whole site or the pages the member picks, for the
 * active goal. A page already running cannot be picked; the engine would
 * hand back the run it already has.
 */

import { useState } from "react";
import { AlertCircle, InfoCircle } from "@untitledui/icons";
import { Button } from "@decocms/ui/components/button.tsx";
import { Checkbox } from "@decocms/ui/components/checkbox.tsx";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@decocms/ui/components/popover.tsx";
import { Spinner } from "@decocms/ui/components/spinner.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useT } from "@/i18n/use-t.ts";
import { formatRelativeTime } from "@/lib/format-time.ts";
import { track } from "@/lib/posthog-client";
import type { PageType } from "./diagnosis-schema.ts";
import { DiagnosisEngineError } from "./diagnosis-state.ts";
import { PAGE_LABEL } from "./labels.ts";
import {
  errorText,
  runRequestedEvent,
  runnablePages,
  runningElsewhere,
  startRunInput,
} from "./opportunity-view.ts";
import { useStartRun, useStoreView } from "./use-plan-diagnosis.ts";

/** `pending` while the goals load; a run then would have no goal. */
export interface RunGoal {
  id: string | null;
  statement: string | null;
  pending: boolean;
}

/** Starts a run for the active goal. `elsewhere` names the pages the engine
 *  said were already running in a run this goal's view does not show. */
export function useRequestRun(goal: RunGoal) {
  const start = useStartRun();
  const view = useStoreView(goal).data;
  const [elsewhere, setElsewhere] = useState<PageType[]>([]);
  const request = (
    scope: "site" | readonly PageType[],
    onStarted?: () => void,
  ) => {
    if (goal.pending) return;
    const input = startRunInput(goal, scope);
    track("plan_run_requested", runRequestedEvent(input));
    setElsewhere([]);
    start.mutate(input, {
      onSuccess: (result) => {
        const busy = runningElsewhere(result, view);
        setElsewhere(busy);
        if (busy.length === 0) onStarted?.();
      },
    });
  };
  return {
    request,
    pending: start.isPending,
    blocked: goal.pending || start.isPending,
    error: start.error,
    elsewhere,
  };
}

/** Why a run did not start, or which pages were already running elsewhere. */
export function RunRequestNotice({
  error,
  elsewhere,
}: {
  error: Error | null;
  elsewhere: readonly PageType[];
}) {
  const t = useT();
  if (error) {
    const needsDomain =
      error instanceof DiagnosisEngineError && error.needsDomain;
    return (
      <div role="alert" className="flex items-start gap-2 text-xs">
        <AlertCircle className="mt-0.5 size-3.5 shrink-0 text-destructive" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-foreground">
            {needsDomain
              ? t("plan.opportunities.newRun.needsDomain")
              : t("plan.opportunities.newRun.failed")}
          </span>
          {!needsDomain && errorText(error) && (
            <span className="break-words text-muted-foreground">
              {errorText(error)}
            </span>
          )}
        </span>
      </div>
    );
  }
  if (elsewhere.length === 0) return null;
  const pages = elsewhere.map((p) => t(PAGE_LABEL[p])).join(", ");
  return (
    <p role="status" className="flex items-start gap-2 text-xs text-foreground">
      <InfoCircle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      {elsewhere.length === 1
        ? t("plan.opportunities.newRun.elsewhere.one", { pages })
        : t("plan.opportunities.newRun.elsewhere.other", { pages })}
    </p>
  );
}

function Choice({
  checked,
  disabled,
  running,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled: boolean;
  running?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-lg px-3 py-2",
        disabled ? "text-muted-foreground" : "cursor-pointer hover:bg-muted",
        checked && "bg-muted",
      )}
    >
      {running ? (
        <Spinner size="2xs" className="mt-0.5 size-4" />
      ) : (
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={(value) => onChange(value === true)}
        />
      )}
      <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3 text-sm">
        <span className={cn(!disabled && "text-foreground")}>{label}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function NewRunForm({ goal, onDone }: { goal: RunGoal; onDone: () => void }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const view = useStoreView(goal).data;
  const run = useRequestRun(goal);
  const [site, setSite] = useState(false);
  const [picked, setPicked] = useState<PageType[]>([]);
  const pages = runnablePages(view);
  const open = pages.filter((p) => !p.disabled).map((p) => p.page_type);
  const chosen = picked.filter((p) => open.includes(p));

  const toggle = (page: PageType, on: boolean) => {
    setSite(false);
    setPicked((current) =>
      on ? [...current, page] : current.filter((p) => p !== page),
    );
  };

  const submitLabel = site
    ? t("plan.opportunities.newRun.submitSite")
    : chosen.length === 0
      ? t("plan.opportunities.newRun.submitNone")
      : chosen.length === 1
        ? t("plan.opportunities.newRun.submit.one")
        : t("plan.opportunities.newRun.submit.other", {
            count: chosen.length,
          });

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1 px-1">
        <h3 className="text-sm font-medium text-foreground">
          {t("plan.opportunities.newRun")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {t("plan.opportunities.newRun.description")}
        </p>
      </div>
      <Choice
        checked={site}
        disabled={open.length === 0}
        onChange={(on) => {
          setSite(on);
          if (on) setPicked([]);
        }}
        label={t("plan.opportunities.newRun.site")}
        hint={t("plan.opportunities.newRun.siteHint")}
      />
      <div className="flex flex-col gap-0.5">
        <p className="px-1 pb-1 text-xs text-muted-foreground">
          {t("plan.opportunities.newRun.or")}
        </p>
        {pages.map((p) => (
          <Choice
            key={p.page_type}
            checked={chosen.includes(p.page_type)}
            disabled={p.disabled}
            running={p.disabled}
            onChange={(on) => toggle(p.page_type, on)}
            label={t(PAGE_LABEL[p.page_type])}
            hint={
              p.disabled
                ? t("plan.opportunities.newRun.running")
                : p.analysed_at
                  ? formatRelativeTime(new Date(p.analysed_at), language)
                  : t("plan.opportunities.newRun.never")
            }
          />
        ))}
      </div>
      <RunRequestNotice error={run.error} elsewhere={run.elsewhere} />
      <div className="flex justify-end border-t border-border pt-3">
        <Button
          size="sm"
          disabled={run.blocked || (!site && chosen.length === 0)}
          onClick={() => run.request(site ? "site" : chosen, onDone)}
        >
          {run.pending && <Spinner size="2xs" />}
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}

/** Opens beside the "Nova análise" button that was clicked. */
export function NewRunPopover({
  anchor,
  goal,
  onClose,
}: {
  anchor: HTMLElement;
  goal: RunGoal;
  onClose: () => void;
}) {
  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={{ current: anchor }} />
      <PopoverContent align="end" className="w-96 p-3">
        <NewRunForm goal={goal} onDone={onClose} />
      </PopoverContent>
    </Popover>
  );
}
