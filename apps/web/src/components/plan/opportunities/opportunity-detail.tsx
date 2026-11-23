/**
 * One loss from the store analysis, on its own page: what the engine measured
 * and saw on the page, what it is worth with the math behind it, how far the
 * data can be trusted, and each hypothesis on why. The analysis status decides
 * what shows first, the same way it does on Plan, so an unconfigured or failing
 * analysis never breaks the page.
 */

import { type ReactNode, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronDown, Monitor01, Phone01 } from "@untitledui/icons";
import { Badge, BadgeDot } from "@decocms/ui/components/badge.tsx";
import { Button } from "@decocms/ui/components/button.tsx";
import { Card } from "@decocms/ui/components/card.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@decocms/ui/components/collapsible.tsx";
import { Skeleton } from "@decocms/ui/components/skeleton.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";
import { Page } from "@/components/page";
import {
  DESTINATION_ROUTE,
  PROJECT_ROUTE,
} from "@/hooks/use-destination-route";
import { usePreferences } from "@/hooks/use-preferences.ts";
import { useScopeId } from "@/hooks/use-project-scope";
import { type TFunction, useT } from "@/i18n/use-t.ts";
import { useProjectContext } from "@/sdk";
import { ConnectCard } from "./connect-card.tsx";
import type {
  OpportunityDetail as Detail,
  OpportunityHypothesis,
} from "./diagnosis-schema.ts";
import { HypothesisCard } from "./hypothesis-card.tsx";
import {
  CONFIDENCE_LABEL,
  DEVICE_LABEL,
  PAGE_LABEL,
  sourceLabel,
  stopLabel,
} from "./labels.ts";
import { SectionError } from "./opportunities-section.tsx";
import {
  confidenceLevel,
  dataBadge,
  detailFailure,
  detailHypotheses,
  errorText,
  formatCount,
  formatMoney,
  formatPercent,
  readyHypothesis,
} from "./opportunity-view.ts";
import {
  useOpportunity,
  usePlanDiagnosisStatus,
} from "./use-plan-diagnosis.ts";

type Money = NonNullable<Detail["money"]>;

export interface OpportunityDetailProps {
  /** The route's id, or null when it cannot be one. */
  opportunityId: string | null;
  /** Starts a business case from the loss's ready hypothesis. Hidden when
   *  absent. */
  onCreateCase?: (
    opportunity: Detail,
    hypothesis: OpportunityHypothesis,
  ) => void;
}

function BackToPlan() {
  const t = useT();
  const { org } = useProjectContext();
  const scopeId = useScopeId();
  const label = (
    <>
      <ArrowLeft />
      {t("plan.opportunities.detail.back")}
    </>
  );
  return (
    <Button asChild variant="ghost" size="sm" className="self-start">
      {scopeId ? (
        <Link
          to={PROJECT_ROUTE.plan}
          params={{ org: org.slug, agentId: scopeId }}
        >
          {label}
        </Link>
      ) : (
        <Link to={DESTINATION_ROUTE.plan} params={{ org: org.slug }}>
          {label}
        </Link>
      )}
    </Button>
  );
}

function Notice({
  heading,
  description,
}: {
  heading: string;
  description: string;
}) {
  return (
    <Card className="items-start gap-1">
      <h2 className="text-base font-medium text-foreground">{heading}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </Card>
  );
}

function NotFound() {
  const t = useT();
  return (
    <Notice
      heading={t("plan.opportunities.detail.notFound.heading")}
      description={t("plan.opportunities.detail.notFound.description")}
    />
  );
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <Skeleton className="h-80 w-full rounded-xl" />
      <Skeleton className="h-4 w-48" />
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </div>
  );
}

function sourceName(t: TFunction, source: string): string {
  const key = sourceLabel(source);
  return key ? t(key) : source;
}

/** The R$ a month, and the engine's own terms behind it on demand. */
function MoneyLine({ money }: { money: Money }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const [open, setOpen] = useState(false);
  const number = (value: number) =>
    new Intl.NumberFormat(language, { maximumFractionDigits: 2 }).format(value);
  const precise = (value: number) =>
    new Intl.NumberFormat(language, {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 2,
    }).format(value);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-lg bg-muted"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 rounded-lg px-4 py-3 text-left focus-ring">
        <span className="text-base font-medium text-foreground">
          {formatMoney(money.monthly_value, language)}
          <span className="text-sm font-normal text-muted-foreground">
            {t("plan.opportunities.card.perMonth")}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {t("plan.opportunities.detail.money.toggle")}
        </span>
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-1.5 px-4 pb-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("plan.opportunities.detail.money.heading")}
        </span>
        {money.assumption && (
          <p className="text-sm text-foreground">{money.assumption}</p>
        )}
        <p className="text-sm text-muted-foreground tabular-nums">
          {t("plan.opportunities.detail.money.formula", {
            base: formatCount(money.base, language),
            baseLabel: money.base_label,
            delta: number(money.delta_pp),
            value: precise(money.value_per_event),
            valueLabel: money.value_label,
            share: formatPercent(money.channel_share, language, 0),
            monthly: formatMoney(money.monthly_value, language),
          })}
        </p>
        {money.ceiling_monthly !== null && (
          <p className="text-xs text-muted-foreground">
            {t("plan.opportunities.detail.money.ceiling", {
              value: formatMoney(money.ceiling_monthly, language),
            })}
          </p>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

/** How far the data can be trusted, in one line: the badge, the rate the
 *  engine measured against the other device, the source and the window. */
function TrustLine({ opportunity: o }: { opportunity: Detail }) {
  const t = useT();
  const [{ language }] = usePreferences();
  const badge = dataBadge(o);
  const m = o.measured;
  const level = confidenceLevel(o.confidence);
  const confidence = level ? t(CONFIDENCE_LABEL[level]) : null;
  const device = (d: keyof typeof DEVICE_LABEL) =>
    t(DEVICE_LABEL[d]).toLowerCase();
  if (!badge && !m && !confidence) return null;
  const measured = m
    ? m.comp
      ? t("plan.opportunities.detail.trust.measuredVs", {
          label: m.label,
          device: device(m.device),
          rate: formatPercent(m.rate, language),
          other: device(m.comp.device),
          otherRate: formatPercent(m.comp.rate, language),
        })
      : t("plan.opportunities.detail.trust.measured", {
          label: m.label,
          device: device(m.device),
          rate: formatPercent(m.rate, language),
        })
    : null;
  const meta = [
    m &&
      t("plan.opportunities.detail.trust.meta", {
        source: sourceName(t, m.source),
        days: m.window_days,
      }),
    confidence,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {badge === "reliable" && (
        <Badge variant="success">
          <BadgeDot />
          {t("plan.opportunities.card.reliable")}
        </Badge>
      )}
      {badge === "low_sample" && (
        <Badge variant="warning">
          <BadgeDot />
          {t("plan.opportunities.card.lowSample")}
        </Badge>
      )}
      {measured && <span className="text-foreground">{measured}</span>}
      {meta.length > 0 && (
        <span className="text-muted-foreground">{meta.join(" · ")}</span>
      )}
    </div>
  );
}

const SEVERITY_CLASS = {
  ok: "bg-success",
  info: "bg-muted-foreground",
  atencao: "bg-warning",
  bloqueia: "bg-destructive",
} as const;

/** The sources behind the loss and the checks behind the reliability badge. */
function DataBehind({ opportunity: o }: { opportunity: Detail }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const checks = o.reliability?.checks ?? [];
  if (o.sources.length === 0 && checks.length === 0) return null;
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="border-t border-border pt-4"
    >
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground focus-ring">
        <ChevronDown
          className={cn(
            "size-4 shrink-0 transition-transform",
            open && "rotate-180",
          )}
        />
        {t("plan.opportunities.detail.data.heading")}
        {o.sources.length > 0 &&
          ` · ${
            o.sources.length === 1
              ? t("plan.opportunities.detail.data.sources.one")
              : t("plan.opportunities.detail.data.sources.other", {
                  count: o.sources.length,
                })
          }`}
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-5 pt-4">
        {o.sources.length > 0 && (
          <Block title={t("plan.opportunities.detail.data.basedOn")}>
            <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
              {o.sources.map((s, i) => (
                <li
                  key={`${i}:${s.source}:${s.metric}`}
                  className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2 text-sm"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <Badge variant="info">{sourceName(t, s.source)}</Badge>
                    <span className="text-muted-foreground">{s.metric}</span>
                  </span>
                  <span className="flex items-baseline gap-2">
                    <span className="font-medium text-foreground tabular-nums">
                      {s.value}
                    </span>
                    {s.window && (
                      <span className="text-xs text-muted-foreground">
                        {s.window}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}
        {checks.length > 0 && (
          <Block title={t("plan.opportunities.detail.data.checks")}>
            <ul className="flex flex-col gap-1.5">
              {checks.map((c, i) => (
                <li key={`${i}:${c.code}`} className="flex gap-2 text-xs">
                  <span
                    className={cn(
                      "mt-1.5 size-1.5 shrink-0 rounded-full",
                      SEVERITY_CLASS[c.severity],
                    )}
                  />
                  <span className="text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {c.label}:
                    </span>{" "}
                    {c.text}
                  </span>
                </li>
              ))}
            </ul>
          </Block>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Problem({ opportunity: o }: { opportunity: Detail }) {
  const t = useT();
  const DeviceIcon = o.device === "desktop" ? Monitor01 : Phone01;
  const compareTo = o.metric?.compare_to;
  const observations = o.observations ?? [];
  return (
    <Card className="gap-4">
      <div className="flex flex-wrap gap-1.5">
        <Badge variant="lime">{t(PAGE_LABEL[o.page_type])}</Badge>
        <Badge variant="muted">
          <DeviceIcon />
          {t(DEVICE_LABEL[o.device])}
        </Badge>
        {o.metric && compareTo && (
          <Badge variant="muted">
            {t("plan.opportunities.detail.compare", {
              device: t(DEVICE_LABEL[o.metric.device]),
              other: t(DEVICE_LABEL[compareTo]),
            })}
          </Badge>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-xl font-medium text-foreground">{o.title}</h2>
        {o.summary && (
          <p className="text-sm text-muted-foreground">{o.summary}</p>
        )}
      </div>
      {observations.length > 0 && (
        <Block title={t("plan.opportunities.detail.observed")}>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            {observations.map((x, i) => (
              <li key={`${i}:${x.text}`}>{x.text}</li>
            ))}
          </ul>
        </Block>
      )}
      {o.outcome && (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">
            {t(stopLabel(o.outcome.stop))}:
          </span>{" "}
          {o.outcome.note}
        </p>
      )}
      {o.money ? (
        <MoneyLine money={o.money} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("plan.opportunities.card.noMoney")}
        </p>
      )}
      <TrustLine opportunity={o} />
      <DataBehind opportunity={o} />
    </Card>
  );
}

function Loaded({
  opportunityId,
  onCreateCase,
}: OpportunityDetailProps & { opportunityId: string }) {
  const t = useT();
  const query = useOpportunity(opportunityId);
  const o = query.data;
  const retry = () => void query.refetch();

  if (query.isPending) return <DetailSkeleton />;
  if (!o) {
    return detailFailure(query.error) === "not_found" ? (
      <NotFound />
    ) : (
      <SectionError
        headline={t("plan.opportunities.detail.error.heading")}
        error={errorText(query.error)}
        retry={retry}
      />
    );
  }

  const hypotheses = detailHypotheses(o);
  const ready = readyHypothesis(o);
  return (
    <>
      <Page.Title>
        {t("plan.opportunities.detail.pageTitle", { rank: o.rank })}
      </Page.Title>
      {query.isError && (
        <SectionError
          headline={t("plan.opportunities.error.stale")}
          error={errorText(query.error)}
          retry={retry}
        />
      )}
      <Problem opportunity={o} />
      <section className="flex flex-col gap-4">
        <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t("plan.opportunities.detail.hypotheses.heading")}
        </h2>
        {hypotheses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("plan.opportunities.detail.hypotheses.empty")}
          </p>
        ) : (
          hypotheses.map((h, i) => (
            <HypothesisCard
              key={h.id}
              hypothesis={h}
              number={i + 1}
              onCreateCase={
                onCreateCase && ready?.id === h.id
                  ? () => onCreateCase(o, h)
                  : undefined
              }
            />
          ))
        )}
      </section>
    </>
  );
}

function DetailBody(props: OpportunityDetailProps) {
  const t = useT();
  const status = usePlanDiagnosisStatus();
  const { opportunityId } = props;
  if (opportunityId === null) return <NotFound />;
  switch (status.state) {
    case "loading":
      return <DetailSkeleton />;
    case "error":
      return <SectionError error={status.error} retry={status.retry} />;
    case "unconfigured":
      return status.reason === "not_connected" ? (
        <ConnectCard />
      ) : (
        <Notice
          heading={t("plan.opportunities.detail.unavailable.heading")}
          description={t("plan.opportunities.detail.unavailable.description")}
        />
      );
    case "configured":
      return <Loaded {...props} opportunityId={opportunityId} />;
  }
}

export function OpportunityDetailPage(props: OpportunityDetailProps) {
  return (
    <Page>
      <Page.Content>
        <Page.Container width="reading" className="flex flex-col gap-6">
          <BackToPlan />
          <DetailBody {...props} />
        </Page.Container>
      </Page.Content>
    </Page>
  );
}
