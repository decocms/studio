/**
 * "Found for you" on Plan: the store analysis behind the active goal, with
 * its two biggest losses. It hides itself where this deployment has no
 * analysis, asks to connect the store's data when it is not set up, and
 * keeps its own errors here so the rest of Plan works as usual.
 */

import type { ReactNode } from "react";
import { AlertCircle, ArrowRight, RefreshCw01 } from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import { ConnectCard } from "./connect-card.tsx";
import type { StoreView } from "./diagnosis-schema.ts";
import { PAGE_LABEL } from "./labels.ts";
import {
  type OpportunityActions,
  OpportunityCard,
} from "./opportunity-card.tsx";
import {
  errorText,
  formatMoney,
  sectionPhase,
  summaryNumbers,
  viewGaps,
  viewScope,
} from "./opportunity-view.ts";
import { RunStatus } from "./run-status.tsx";
import { usePlanDiagnosisStatus, useStoreView } from "./use-plan-diagnosis.ts";

export interface OpportunitiesSectionProps extends OpportunityActions {
  /** The goal the analysis is read for; a null id reads every run. */
  goal: { id: string | null; statement: string | null };
  /** Starts a new analysis. Hidden when absent. */
  onNewRun?: () => void;
  /** Opens the store, step by step. Hidden when absent. */
  onOpenStore?: () => void;
}

function NewRunButton({ onNewRun }: { onNewRun?: () => void }) {
  const t = useT();
  if (!onNewRun) return null;
  return (
    <Button variant="outline" size="sm" onClick={onNewRun}>
      <RefreshCw01 />
      {t("plan.opportunities.newRun")}
    </Button>
  );
}

function Frame({
  eyebrow,
  action,
  children,
}: {
  eyebrow?: string | null;
  action?: ReactNode;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          {eyebrow && (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {eyebrow}
            </p>
          )}
          <h2 className="text-xl font-medium text-foreground">
            {t("plan.opportunities.heading")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("plan.opportunities.description")}
          </p>
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {children}
    </section>
  );
}

function SectionSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-6 w-56" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-72 w-full rounded-xl" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    </div>
  );
}

/** A translated headline; the engine's own message, often technical, is the
 *  detail under it. */
export function SectionError({
  error,
  retry,
  headline,
}: {
  error: string | null;
  retry: () => void;
  headline?: string;
}) {
  const t = useT();
  return (
    <Card size="tile" className="flex-row items-start gap-3" role="alert">
      <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm text-foreground">
          {headline ?? t("plan.opportunities.error.heading")}
        </span>
        {error && (
          <span className="break-words text-xs text-muted-foreground">
            {error}
          </span>
        )}
      </div>
      <Button variant="outline" size="sm" onClick={retry}>
        {t("plan.opportunities.error.retry")}
      </Button>
    </Card>
  );
}

function scopeLine(
  view: StoreView,
  t: TFunction,
  language: string,
): string | null {
  const scope = viewScope(view);
  if (scope.pages.length === 0) return null;
  const where = scope.whole
    ? t("plan.opportunities.scope.whole")
    : scope.pages.map((p) => t(PAGE_LABEL[p])).join(", ");
  if (!scope.analysedAt) return where;
  const date = new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
  }).format(new Date(scope.analysedAt));
  return `${where} · ${t("plan.opportunities.scope.analysed", { date })}`;
}

function Summary({ view }: { view: StoreView }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const numbers = summaryNumbers(view);
  const gaps = viewGaps(view);
  const biggest = view.top[0];
  const stat = (value: string, label: string) => (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xl font-medium text-foreground">{value}</span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
  return (
    <Card className="gap-5">
      {biggest && (
        <p className="max-w-2xl text-lg text-foreground">
          {numbers.pages === 1
            ? t("plan.opportunities.summary.sentence.one", {
                title: biggest.title,
              })
            : t("plan.opportunities.summary.sentence.other", {
                count: numbers.pages,
                title: biggest.title,
              })}
        </p>
      )}
      <div className="flex flex-wrap items-end justify-between gap-6 border-t border-border pt-5">
        <div className="flex flex-wrap gap-10">
          {stat(
            String(numbers.measured),
            numbers.pages === 1
              ? t("plan.opportunities.summary.measured.one")
              : t("plan.opportunities.summary.measured.other", {
                  count: numbers.pages,
                }),
          )}
          {stat(String(numbers.chosen), t("plan.opportunities.summary.chosen"))}
          {numbers.topMonthly > 0 &&
            stat(
              formatMoney(numbers.topMonthly, language),
              numbers.chosen === 1
                ? t("plan.opportunities.summary.monthly.one")
                : t("plan.opportunities.summary.monthly.other", {
                    count: numbers.chosen,
                  }),
            )}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">
            {t("plan.opportunities.summary.sources")}
          </span>
          <div className="flex max-w-64 flex-wrap gap-1.5">
            {view.sources.length === 0 ? (
              <Badge variant="muted">
                {t("plan.opportunities.summary.noSources")}
              </Badge>
            ) : (
              view.sources.map((source) => (
                <Badge key={source} variant="info">
                  {source}
                </Badge>
              ))
            )}
          </div>
        </div>
      </div>
      {gaps.length > 0 && <Gaps gaps={gaps} />}
    </Card>
  );
}

function Gaps({ gaps }: { gaps: string[] }) {
  const t = useT();
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="text-muted-foreground">
        {t("plan.opportunities.summary.gaps")}
      </span>
      <ul className="flex flex-col gap-0.5 text-warning">
        {gaps.map((gap) => (
          <li key={gap}>{gap}</li>
        ))}
      </ul>
    </div>
  );
}

/** Nothing found: either the run had no sources to measure with, which the
 *  gaps name, or it measured and found no loss. */
function Empty({
  view,
  noSources,
  onNewRun,
}: {
  view: StoreView;
  noSources: boolean;
  onNewRun?: () => void;
}) {
  const t = useT();
  const gaps = viewGaps(view);
  const failed = view.pages.filter(
    (p) => p.status === "error" && p.progress_note,
  );
  return (
    <Card className="items-start gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">
          {noSources
            ? t("plan.opportunities.noSources.heading")
            : t("plan.opportunities.empty.heading")}
        </h3>
        <p className="text-sm text-muted-foreground">
          {noSources
            ? t("plan.opportunities.noSources.description")
            : t("plan.opportunities.empty.description")}
        </p>
      </div>
      {failed.length > 0 && (
        <div className="flex flex-col gap-1 text-xs">
          <span className="text-muted-foreground">
            {t("plan.opportunities.empty.failed")}
          </span>
          <ul className="flex flex-col gap-0.5 text-destructive">
            {failed.map((p) => (
              <li key={p.page_type}>
                {`${t(PAGE_LABEL[p.page_type])}: ${p.progress_note}`}
              </li>
            ))}
          </ul>
        </div>
      )}
      {gaps.length > 0 && <Gaps gaps={gaps} />}
      <NewRunButton onNewRun={onNewRun} />
    </Card>
  );
}

function StoreSection({
  goal,
  onNewRun,
  onOpenStore,
  ...actions
}: OpportunitiesSectionProps) {
  const t = useT();
  const [{ language }] = usePreferences();
  const query = useStoreView(goal.id);
  const view = query.data;
  const retry = () => void query.refetch();

  if (query.isPending) return <SectionSkeleton />;
  if (!view) {
    return (
      <Frame>
        <SectionError error={errorText(query.error)} retry={retry} />
      </Frame>
    );
  }

  const stale = query.isError && (
    <SectionError
      headline={t("plan.opportunities.error.stale")}
      error={errorText(query.error)}
      retry={retry}
    />
  );
  const phase = sectionPhase(view);
  const eyebrow = scopeLine(view, t, language);

  if (phase.phase === "running") {
    return (
      <section className="flex flex-col gap-4">
        <RunStatus pages={view.pages} />
        {stale}
      </section>
    );
  }

  if (phase.phase === "empty" || phase.phase === "no_sources") {
    return (
      <Frame eyebrow={eyebrow}>
        {stale}
        <Empty
          view={view}
          noSources={phase.phase === "no_sources"}
          onNewRun={onNewRun}
        />
      </Frame>
    );
  }

  const others = view.others.length;
  return (
    <Frame eyebrow={eyebrow} action={<NewRunButton onNewRun={onNewRun} />}>
      {stale}
      {phase.refreshing && (
        <p className="text-sm text-muted-foreground" role="status">
          {t("plan.opportunities.refreshing")}
        </p>
      )}
      <Summary view={view} />
      <div className="grid items-start gap-4 md:grid-cols-2">
        {view.top.map((opportunity, position) => (
          <OpportunityCard
            key={opportunity.id}
            opportunity={opportunity}
            position={position}
            {...actions}
          />
        ))}
      </div>
      {onOpenStore && (
        <Button variant="link" className="self-center" onClick={onOpenStore}>
          {others === 0
            ? t("plan.opportunities.store")
            : others === 1
              ? t("plan.opportunities.store.one")
              : t("plan.opportunities.store.other", { count: others })}
          <ArrowRight />
        </Button>
      )}
    </Frame>
  );
}

/** For an error boundary around the section: the section's error card, so a
 *  render failure here leaves the rest of Plan working. */
export function OpportunitiesSectionFallback({
  error,
  resetError,
}: {
  error: Error | null;
  resetError: () => void;
}) {
  return (
    <Frame>
      <SectionError error={errorText(error)} retry={resetError} />
    </Frame>
  );
}

export function OpportunitiesSection(props: OpportunitiesSectionProps) {
  const status = usePlanDiagnosisStatus();
  switch (status.state) {
    case "loading":
      // Most deployments answer "not available", so nothing holds the space.
      return null;
    case "error":
      return (
        <Frame>
          <SectionError error={status.error} retry={status.retry} />
        </Frame>
      );
    case "unconfigured":
      return status.reason === "not_connected" ? <ConnectCard /> : null;
    case "configured":
      return <StoreSection {...props} />;
  }
}
