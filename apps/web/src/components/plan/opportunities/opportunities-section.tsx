/**
 * "Found for you" on Plan: the store analysis behind the active goal, with
 * its two biggest losses. It hides itself where this deployment has no
 * analysis, asks to connect the store's data when it is not set up, and
 * keeps its own errors here so the rest of Plan works as usual.
 */

import type { ReactNode } from "react";
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  RefreshCw01,
} from "@untitledui/icons";
import { Badge } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import { CompetitorsRow } from "./competitors-field.tsx";
import { ConnectCard } from "./connect-card.tsx";
import type { RunGoal } from "./new-run-popover.tsx";
import type { SetupKey, SetupNeed, StoreView } from "./diagnosis-schema.ts";
import { PAGE_LABEL } from "./labels.ts";
import {
  type OpportunityActions,
  OpportunityCard,
} from "./opportunity-card.tsx";
import {
  errorText,
  formatMoney,
  gapGroups,
  sectionPhase,
  setupNeeds,
  summaryNumbers,
  viewScope,
} from "./opportunity-view.ts";
import { RunStatus } from "./run-status.tsx";
import { SETUP_CARD_ID, SetupCard } from "./setup-card.tsx";
import { StoreDomainRow } from "./store-domain.tsx";
import { usePlanDiagnosisStatus, useStoreView } from "./use-plan-diagnosis.ts";

export interface OpportunitiesSectionProps extends OpportunityActions {
  /** The goal the analysis is read for; a null id reads every run. */
  goal: RunGoal;
  /** Opens "Nova análise" beside the button that was clicked. Hidden when
   *  absent. */
  onNewRun?: (anchor: HTMLElement) => void;
  /** Opens the store, step by step. Hidden when absent. */
  onOpenStore?: () => void;
}

export function NewRunButton({
  onNewRun,
}: {
  onNewRun?: (anchor: HTMLElement) => void;
}) {
  const t = useT();
  if (!onNewRun) return null;
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={(e) => onNewRun(e.currentTarget)}
    >
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

function Summary({ view, needs }: { view: StoreView; needs: CardNeeds }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const numbers = summaryNumbers(view);
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
      <Gaps view={view} needs={needs} />
    </Card>
  );
}

/** What did not answer: what the customer can provide, each pointing to the
 *  setup card when the card asks for it, and the analysis's own limits,
 *  folded away. An old engine's gaps have no owner and stay listed open. */
function Gaps({ view, needs }: { view: StoreView; needs: CardNeeds }) {
  const t = useT();
  const { legacy, customer, limitations } = gapGroups(view);
  if (customer.length === 0 && limitations.length === 0) return null;
  if (legacy) {
    return (
      <div className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">
          {t("plan.opportunities.summary.gaps")}
        </span>
        <ul className="flex flex-col gap-0.5 text-warning">
          {limitations.map((gap) => (
            <li key={gap}>{gap}</li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 text-xs">
      {customer.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">
            {t("plan.opportunities.gaps.provide")}
          </span>
          <ul className="flex flex-col gap-0.5">
            {customer.map((gap) => (
              <li
                key={gap.key ?? gap.message}
                className="flex flex-wrap gap-x-2"
              >
                <span className="text-warning">{gap.message}</span>
                {needs.some((n) => n.key === gap.key) && (
                  <a
                    href={`#${SETUP_CARD_ID}`}
                    className="rounded-sm text-foreground underline-offset-2 hover:underline focus-ring"
                  >
                    {t("plan.opportunities.gaps.provideAction")}
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {limitations.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex items-center gap-1 rounded-md text-muted-foreground hover:text-foreground focus-ring">
            {t("plan.opportunities.gaps.limitations", {
              count: limitations.length,
            })}
            <ChevronDown className="size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="flex flex-col gap-0.5 pt-1 text-muted-foreground">
              {limitations.map((gap) => (
                <li key={gap}>{gap}</li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

type CardNeeds = (SetupNeed & { key: SetupKey })[];

/** The setup card shows once a need does not block a run, and then asks for
 *  every need; a blocking need alone is asked when a run is refused for it. */
function cardNeeds(view: StoreView): CardNeeds {
  const needs = setupNeeds(view);
  return needs.some((n) => !n.blocking) ? needs : [];
}

/** The rows show what is set, unless the card is asking for it. */
function StoreSetup({ view, needs }: { view: StoreView; needs: CardNeeds }) {
  const asks = (key: SetupKey) => needs.some((n) => n.key === key);
  // The engine's field is named `current`; a destructure keeps it apart from a ref.
  const { current } = view.setup ?? {};
  const competitors = current?.competitors ?? [];
  return (
    <>
      {needs.length > 0 && (
        <SetupCard needs={needs} competitors={competitors} />
      )}
      {!asks("domain") && <StoreDomainRow known={current?.domain} />}
      {!asks("competitors") && competitors.length > 0 && (
        <CompetitorsRow list={competitors} />
      )}
    </>
  );
}

const EMPTY_TEXT = {
  failed: {
    heading: "plan.opportunities.failed.heading",
    description: "plan.opportunities.failed.description",
  },
  no_sources: {
    heading: "plan.opportunities.noSources.heading",
    description: "plan.opportunities.noSources.description",
  },
  empty: {
    heading: "plan.opportunities.empty.heading",
    description: "plan.opportunities.empty.description",
  },
} as const;

/** Nothing found: every page failed, the run had no sources to measure
 *  with, or it measured and found no loss. */
function Empty({
  view,
  reason,
  needs,
  onNewRun,
}: {
  view: StoreView;
  reason: keyof typeof EMPTY_TEXT;
  needs: CardNeeds;
  onNewRun?: (anchor: HTMLElement) => void;
}) {
  const t = useT();
  const failed = view.pages.filter(
    (p) => p.status === "error" && p.progress_note,
  );
  return (
    <Card className="items-start gap-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-base font-medium text-foreground">
          {t(EMPTY_TEXT[reason].heading)}
        </h3>
        <p className="text-sm text-muted-foreground">
          {t(EMPTY_TEXT[reason].description)}
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
      <Gaps view={view} needs={needs} />
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
  const query = useStoreView(goal);
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
  const needs = cardNeeds(view);
  const setup = <StoreSetup view={view} needs={needs} />;

  if (phase.phase === "running") {
    return (
      <section className="flex flex-col gap-4">
        <RunStatus pages={view.pages} />
        {setup}
        {stale}
      </section>
    );
  }

  if (phase.phase !== "results") {
    return (
      <Frame eyebrow={eyebrow}>
        {setup}
        {stale}
        <Empty
          view={view}
          reason={phase.phase}
          needs={needs}
          onNewRun={onNewRun}
        />
      </Frame>
    );
  }

  const others = view.others.length;
  return (
    <Frame eyebrow={eyebrow} action={<NewRunButton onNewRun={onNewRun} />}>
      {setup}
      {stale}
      {phase.refreshing && (
        <p className="text-sm text-muted-foreground" role="status">
          {t("plan.opportunities.refreshing")}
        </p>
      )}
      <Summary view={view} needs={needs} />
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
